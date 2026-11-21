import {
  isProviderAvailable,
  type ModelSelection,
  PLACEMENT_TAG_PREFIX,
  type PlacementActiveHours,
  type PlacementEntry,
  type PlacementEntryDecision,
  type PlacementPolicy,
  type PlacementProfile,
  type PlacementProfileDecision,
  type ProjectId,
  resolveProjectProviderInstanceEnabled,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type ServerSettings,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import { modelUsageWindows } from "./usageLimits.ts";

const HOUR = 3_600_000;
const SESSION_HOURS = 5;

/** The profile a thread runs in, from its `placement:<id>` tag. */
export function placementProfileOfTags(tags: ReadonlyArray<string> | undefined): string | null {
  const tag = tags?.find((candidate) => candidate.startsWith(PLACEMENT_TAG_PREFIX));
  const id = tag?.slice(PLACEMENT_TAG_PREFIX.length).trim();
  return id ? id : null;
}

export function placementTag(profileId: string): string {
  return `${PLACEMENT_TAG_PREFIX}${profileId}`;
}

export function placementEntryKey(selection: Pick<ModelSelection, "instanceId" | "model">) {
  return `${selection.instanceId}\u0000${selection.model}`;
}

export function sameEntry(
  a: Pick<ModelSelection, "instanceId" | "model">,
  b: Pick<ModelSelection, "instanceId" | "model">,
) {
  return a.instanceId === b.instanceId && a.model === b.model;
}

export interface PlacementLoad {
  /** Threads with a run in progress on this entry. */
  readonly running: number;
  /** Session percent one running thread spends per hour, when it has been measured. */
  readonly burnPerThreadPerHour?: number;
}

export interface PlacementRankInput {
  readonly id: string;
  readonly profile: PlacementProfile;
  readonly policy: PlacementPolicy;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly sources: ReadonlyArray<UsageLimitSourceSnapshot>;
  readonly now: number;
  readonly load: (selection: ModelSelection) => PlacementLoad;
  readonly settings?: ServerSettings;
  readonly projectId?: ProjectId | null;
}

interface Reading {
  readonly usedPercent: number;
  readonly resetsAt?: string;
}

/** A window whose reported reset has passed reads as unused until the next probe says otherwise. */
function liveUsed(window: ServerProviderUsageWindow, now: number) {
  const reset = window.resetsAt === undefined ? NaN : Date.parse(window.resetsAt);
  return Number.isFinite(reset) && reset <= now ? 0 : window.usedPercent;
}

function worst(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  now: number,
): Reading | undefined {
  let best: Reading | undefined;
  for (const window of windows) {
    const used = liveUsed(window, now);
    if (best === undefined || used > best.usedPercent) {
      best = {
        usedPercent: used,
        ...(window.resetsAt === undefined || used === 0 ? {} : { resetsAt: window.resetsAt }),
      };
    }
  }
  return best;
}

/**
 * The windows that limit one model. A usage hub (CLIProxyAPI) that routes the model to its own
 * accounts knows each account's windows, so those win over the provider instance's own, which
 * describe whichever account served it last. Several accounts routing one model form a pool:
 * the one with the most headroom speaks for it.
 */
export function placementWindows(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
  sources: ReadonlyArray<UsageLimitSourceSnapshot>,
  now: number,
): ReadonlyArray<ServerProviderUsageWindow> | null {
  const routed = sources
    .flatMap((source) => source.accounts)
    .filter(
      (account) => account.models?.includes(selection.model) && !account.usageLimits.unavailable,
    );
  if (routed.length > 0) {
    const scored = routed.map((account) => {
      const windows = modelUsageWindows(
        {
          driver: account.driver,
          usageLimits: account.usageLimits,
        } as ServerProvider,
        selection.model.includes("/")
          ? selection.model.split("/").slice(1).join("/")
          : selection.model,
      );
      return { windows, used: worst(windows, now)?.usedPercent ?? 0 };
    });
    scored.sort((a, b) => a.used - b.used);
    return scored[0]?.windows ?? null;
  }
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  if (!provider?.usageLimits || provider.usageLimits.unavailable) return null;
  return modelUsageWindows(provider, selection.model);
}

/** Hours from `now` to `until` that fall inside the active hours (every hour without them). */
export function usableHours(
  now: number,
  until: number,
  activeHours?: PlacementActiveHours,
  zone: DateTime.TimeZone = DateTime.zoneMakeLocal(),
) {
  if (until <= now) return 0;
  if (activeHours === undefined) return (until - now) / HOUR;
  const inside = (hour: number) =>
    activeHours.start < activeHours.end
      ? hour >= activeHours.start && hour < activeHours.end
      : hour >= activeHours.start || hour < activeHours.end;
  let total = 0;
  for (let at = now; at < until;) {
    const step = Math.min(HOUR - (at % HOUR), until - at);
    if (inside(DateTime.toParts(DateTime.makeZonedUnsafe(at, { timeZone: zone })).hour)) {
      total += step;
    }
    at += step;
  }
  return total / HOUR;
}

function selectionRunnable(
  selection: ModelSelection,
  input: Pick<PlacementRankInput, "providers" | "settings" | "projectId">,
) {
  const provider = input.providers.find((entry) => entry.instanceId === selection.instanceId);
  if (provider === undefined) return "its provider instance is not configured";
  if (!provider.enabled) return "its provider instance is disabled";
  if (!provider.installed || !isProviderAvailable(provider)) return "its provider is not available";
  if (provider.auth.status === "unauthenticated") return "its provider is signed out";
  if (
    provider.models.length > 0 &&
    !provider.models.some((model) => model.slug === selection.model)
  ) {
    return "its provider does not list this model";
  }
  if (
    input.settings &&
    !resolveProjectProviderInstanceEnabled(
      input.settings,
      input.projectId ?? null,
      provider.instanceId,
    )
  ) {
    return "its provider instance is off for this project";
  }
  return null;
}

const percent = (value: number) => `${Math.round(value)}%`;

function decideEntry(entry: PlacementEntry, input: PlacementRankInput): PlacementEntryDecision {
  const { selection } = entry;
  const load = input.load(selection);
  const base = { selection, runningThreads: load.running };
  if (!entry.enabled) return { ...base, state: "disabled", reason: "Turned off in the profile." };
  const blocked = selectionRunnable(selection, input);
  if (blocked !== null) return { ...base, state: "unavailable", reason: `Skipped: ${blocked}.` };

  const windows = placementWindows(selection, input.providers, input.sources, input.now) ?? [];
  const session = worst(
    windows.filter((window) => window.kind === "session"),
    input.now,
  );
  const weekly = worst(
    windows.filter((window) => window.kind === "weekly"),
    input.now,
  );
  const all = worst(windows, input.now);
  const readings = {
    ...(session === undefined ? {} : { session }),
    ...(weekly === undefined ? {} : { weekly }),
  };
  if (all !== undefined && all.usedPercent >= 100) {
    return {
      ...base,
      ...readings,
      state: "exhausted",
      reason: `Out of usage${all.resetsAt ? ` until ${all.resetsAt}` : ""}.`,
    };
  }
  if (all !== undefined && all.usedPercent >= input.policy.switchAtPercent) {
    return {
      ...base,
      ...readings,
      state: "over_threshold",
      reason: `A limit is at ${percent(all.usedPercent)}, at or past the ${percent(input.policy.switchAtPercent)} switch point.`,
    };
  }

  let predictedSessionPercent: number | undefined;
  if (session !== undefined && load.burnPerThreadPerHour !== undefined) {
    const reset = session.resetsAt === undefined ? NaN : Date.parse(session.resetsAt);
    const hoursLeft = Number.isFinite(reset)
      ? Math.max(0, (reset - input.now) / HOUR)
      : SESSION_HOURS;
    predictedSessionPercent =
      session.usedPercent + load.burnPerThreadPerHour * (load.running + 1) * hoursLeft;
  }

  let weeklySlackSessions: number | undefined;
  if (entry.sessionShareOfWeekly !== undefined && weekly !== undefined && weekly.resetsAt) {
    const needed = (100 - weekly.usedPercent) / entry.sessionShareOfWeekly;
    const left =
      usableHours(input.now, Date.parse(weekly.resetsAt), input.policy.activeHours) / SESSION_HOURS;
    weeklySlackSessions = Math.round((left - needed) * 10) / 10;
  }
  const decision = {
    ...base,
    ...readings,
    ...(predictedSessionPercent === undefined ? {} : { predictedSessionPercent }),
    ...(weeklySlackSessions === undefined ? {} : { weeklySlackSessions }),
  };
  if (
    predictedSessionPercent !== undefined &&
    predictedSessionPercent > input.policy.switchAtPercent
  ) {
    return {
      ...decision,
      state: "full",
      reason: `${load.running} running thread${load.running === 1 ? "" : "s"} plus one more would reach about ${percent(predictedSessionPercent)} of the session window before it resets.`,
    };
  }
  if (
    weeklySlackSessions !== undefined &&
    weeklySlackSessions <= input.policy.weeklySlackSessions
  ) {
    return {
      ...decision,
      state: "promoted",
      reason: `Preferred: using the rest of the weekly allowance takes all but ${weeklySlackSessions} of the session windows left before the weekly reset.`,
    };
  }
  return {
    ...decision,
    state: "ok",
    reason: session
      ? `Session window at ${percent(session.usedPercent)}.`
      : "No usage reported; used in profile order.",
  };
}

const RUNNABLE = new Set(["ok", "promoted", "full"]);

/** The profile's entries in the order a new thread tries them, and the one it starts on. */
export function rankPlacementProfile(input: PlacementRankInput): PlacementProfileDecision {
  const decided = input.profile.entries.map((entry, index) => ({
    index,
    decision: decideEntry(entry, input),
  }));
  const group = (state: string) =>
    state === "promoted" ? 0 : state === "ok" ? 1 : state === "full" ? 2 : 3;
  decided.sort(
    (a, b) =>
      group(a.decision.state) - group(b.decision.state) ||
      (a.decision.state === "promoted" && b.decision.state === "promoted"
        ? (a.decision.weeklySlackSessions ?? 0) - (b.decision.weeklySlackSessions ?? 0)
        : 0) ||
      a.index - b.index,
  );
  const ranked = decided.map(({ decision }) => decision);
  const next = ranked.find((decision) => RUNNABLE.has(decision.state))?.selection ?? null;
  return { id: input.id, label: input.profile.label, next, ranked };
}

/**
 * Where a thread in the profile should move, or null to stay. A thread stays on its entry
 * while that entry can still run; it moves when the entry crossed the switch point, ran out,
 * was turned off, or is not part of the profile at all.
 */
export function placementMoveTarget(
  decision: PlacementProfileDecision,
  current: ModelSelection,
): { readonly to: ModelSelection; readonly reason: string } | null {
  const own = decision.ranked.find((entry) => sameEntry(entry.selection, current));
  if (own !== undefined && RUNNABLE.has(own.state)) return null;
  const to = decision.ranked.find(
    (entry) => RUNNABLE.has(entry.state) && !sameEntry(entry.selection, current),
  )?.selection;
  if (to === undefined) return null;
  return {
    to,
    reason:
      own === undefined
        ? `${current.model} is not part of the "${decision.label}" profile`
        : own.reason,
  };
}
