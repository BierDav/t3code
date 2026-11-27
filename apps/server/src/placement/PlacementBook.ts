import type {
  ModelSelection,
  PlacementMove,
  PlacementProfileDecision,
  ProjectId,
  ServerProvider,
  ServerSettings,
  UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import {
  placementAcceptsNewWork,
  placementEntryKey,
  placementSelectionOutOfUsage,
  selectionRunnable,
  type PlacementLoad,
  rankPlacementProfile,
} from "@t3tools/shared/placement";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";

const HOUR = 3_600_000;
/** How far back session readings count toward an account's burn rate. */
const BURN_WINDOW_MS = 45 * 60_000;
const MIN_BURN_SPAN_MS = 10 * 60_000;
const RECENT_BURN_WINDOW_MS = 15 * 60_000;
const MAX_MOVES = 50;
/** How long a remote placement provider's ranking stays authoritative before local fallback. */
export const REMOTE_DECISION_TTL_MS = 2 * 60_000;

interface Sample {
  readonly at: number;
  readonly used: number;
  readonly running: number;
}

/**
 * What the placement worker last saw: hub readings, threads running per account, measured
 * burn rates and recent moves. Thread starts read it to choose an account without waiting on
 * a probe, so it is plain memory shared by the worker and the launch paths of one server.
 */
export interface PlacementBook {
  sources: ReadonlyArray<UsageLimitSourceSnapshot>;
  readonly running: Map<string, number>;
  readonly samples: Map<string, Sample[]>;
  readonly burn: Map<string, number>;
  readonly moves: PlacementMove[];
  readonly limitedUntilByAccount: Map<string, number>;
  readonly remoteDecisions: Map<string, PlacementProfileDecision>;
  remoteCheckedAt: number;
  checkedAt: number;
}

export function makePlacementBook(): PlacementBook {
  return {
    sources: [],
    running: new Map(),
    samples: new Map(),
    burn: new Map(),
    moves: [],
    limitedUntilByAccount: new Map(),
    remoteDecisions: new Map(),
    remoteCheckedAt: 0,
    checkedAt: 0,
  };
}

const shared = makePlacementBook();

export class PlacementBookRef extends Context.Reference<PlacementBook>(
  "t3/placement/PlacementBook",
  { defaultValue: () => shared },
) {}

function placementLoad(book: PlacementBook) {
  return (selection: ModelSelection): PlacementLoad => {
    const key = placementEntryKey(selection);
    const burn = book.burn.get(key);
    return {
      running: book.running.get(key) ?? 0,
      ...(burn === undefined ? {} : { burnPerThreadPerHour: burn }),
    };
  };
}

/**
 * Records one session reading for an account and refreshes its burn rate: the percent one
 * running thread spends per hour over the last readings. A drop means the window reset, so
 * the readings before it no longer count.
 */
export function recordSessionSample(
  book: PlacementBook,
  key: string,
  sample: Sample,
): number | undefined {
  const previous = book.samples.get(key) ?? [];
  const last = previous.at(-1);
  const reset = last !== undefined && sample.used + 0.5 < last.used;
  const kept = reset ? [] : previous.filter((entry) => sample.at - entry.at <= BURN_WINDOW_MS);
  if (reset) book.burn.delete(key);
  const samples = [...kept, sample];
  book.samples.set(key, samples);
  const rate = (readings: ReadonlyArray<Sample>) => {
    const first = readings[0];
    if (first === undefined) return undefined;
    const span = sample.at - first.at;
    const meanRunning =
      readings.reduce((total, entry) => total + entry.running, 0) / readings.length;
    return span >= MIN_BURN_SPAN_MS && meanRunning >= 0.5
      ? Math.max(0, (sample.used - first.used) / (span / HOUR) / meanRunning)
      : undefined;
  };
  const full = rate(samples);
  const recent = rate(samples.filter((entry) => sample.at - entry.at <= RECENT_BURN_WINDOW_MS));
  if (full !== undefined || recent !== undefined) {
    book.burn.set(key, Math.max(full ?? 0, recent ?? 0));
  }
  return book.burn.get(key);
}

export function recordMove(book: PlacementBook, move: PlacementMove) {
  const index = book.moves.findIndex(
    (entry) => entry.threadId === move.threadId && entry.at === move.at,
  );
  if (index >= 0) book.moves.splice(index, 1);
  book.moves.unshift(move);
  book.moves.length = Math.min(book.moves.length, MAX_MOVES);
}

export function recordRemoteDecisions(
  book: PlacementBook,
  decisions: ReadonlyArray<PlacementProfileDecision>,
  nowMs: number,
) {
  book.remoteDecisions.clear();
  for (const decision of decisions) {
    book.remoteDecisions.set(decision.id, decision);
  }
  book.remoteCheckedAt = nowMs;
}

// Gateway Codex and Claude expose several models per named account on one
// instance. Antigravity pools can have separate limits for each routed model.
function rejectionKey(selection: ModelSelection) {
  const slash = selection.model.indexOf("/");
  const account =
    (selection.instanceId === "codex" || selection.instanceId === "claudeAgent") && slash > 0
      ? selection.model.slice(0, slash)
      : selection.model;
  return placementEntryKey({ instanceId: selection.instanceId, model: account });
}

export function recordPlacementLimit(
  book: PlacementBook,
  selection: ModelSelection,
  failedAt: number,
  reportedReset: number,
) {
  const until =
    Number.isFinite(reportedReset) && reportedReset > failedAt
      ? reportedReset
      : failedAt + 10 * 60_000;
  const key = rejectionKey(selection);
  book.limitedUntilByAccount.set(key, Math.max(book.limitedUntilByAccount.get(key) ?? 0, until));
}

export function placementLimitedUntil(book: PlacementBook, selection: ModelSelection, now: number) {
  const reset = book.limitedUntilByAccount.get(rejectionKey(selection)) ?? 0;
  return reset > now ? reset : null;
}

export function decideProfile(
  book: PlacementBook,
  input: {
    readonly profileId: string;
    readonly settings: ServerSettings;
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly now: number;
    readonly projectId?: ProjectId | null;
    readonly useLocal?: boolean;
  },
): PlacementProfileDecision | null {
  const profile = input.settings.placementProfiles[input.profileId];
  if (profile === undefined) return null;
  const remote =
    input.useLocal !== true &&
    book.remoteCheckedAt > 0 &&
    input.now - book.remoteCheckedAt < REMOTE_DECISION_TTL_MS
      ? book.remoteDecisions.get(input.profileId)
      : undefined;
  const decision =
    remote ??
    rankPlacementProfile({
      id: input.profileId,
      profile,
      policy: input.settings.placementPolicy,
      providers: input.providers,
      sources: book.sources,
      now: input.now,
      load: placementLoad(book),
      settings: input.settings,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    });
  const ranked = decision.ranked.map((entry) => {
    const reset = placementLimitedUntil(book, entry.selection, input.now);
    if (reset !== null && entry.state !== "disabled" && entry.state !== "unavailable") {
      return {
        ...entry,
        state: "exhausted" as const,
        reason: "The provider rejected a run on this account until its quota resets.",
        session: { usedPercent: 100, resetsAt: DateTime.formatIso(DateTime.makeUnsafe(reset)) },
      };
    }
    if (remote !== undefined && placementAcceptsNewWork(entry)) {
      const blocked = selectionRunnable(entry.selection, input);
      if (blocked !== null) {
        return { ...entry, state: "unavailable" as const, reason: `Skipped: ${blocked}.` };
      }
      if (placementSelectionOutOfUsage(entry.selection, input.providers, book.sources, input.now)) {
        return {
          ...entry,
          state: "exhausted" as const,
          reason: "The host reports that this account is out of usage.",
        };
      }
      // Older Prism workers did not send the admission flag.
      if ((entry.session?.usedPercent ?? 0) >= input.settings.placementPolicy.switchAtPercent) {
        return { ...entry, acceptsNewWork: false };
      }
    }
    return entry;
  });
  return { ...decision, ranked, next: ranked.find(placementAcceptsNewWork)?.selection ?? null };
}
