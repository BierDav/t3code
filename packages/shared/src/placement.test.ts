import {
  DEFAULT_PLACEMENT_POLICY,
  DEFAULT_SERVER_SETTINGS,
  PLACEMENT_INSTANCE_ID,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type PlacementProfile,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type UsageLimitSourceAccount,
  type UsageLimitSourceSnapshot,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  placementMoveTarget,
  placementPickSelection,
  placementProfileOfTags,
  placementTag,
  rankPlacementProfile,
  usableHours,
  withPlacementInstanceSetting,
  withPlacementProvider,
  type PlacementLoad,
} from "./placement.ts";

const now = Date.parse("2026-11-21T14:30:00.000Z");
const hours = (count: number) => DateTime.formatIso(DateTime.makeUnsafe(now + count * 3_600_000));

const claude = (model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model,
});
const david = claude("claude-david/claude-opus-5-5");
const one = claude("claude-1/claude-opus-5-5");
const alex = claude("claude-alex/claude-opus-5-5");

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-21T14:00:00.000Z",
  models: [david, one, alex].map((selection) => ({
    slug: selection.model,
    name: selection.model,
    isCustom: true,
    capabilities: null,
  })) as unknown as ServerProvider["models"],
  slashCommands: [],
  skills: [],
};

const windows = (
  session: number,
  weekly: number,
  weeklyResetHours = 72,
): ServerProviderUsageWindow[] => [
  {
    id: "five_hour",
    kind: "session",
    label: "Session",
    usedPercent: session,
    resetsAt: hours(3),
  },
  {
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    usedPercent: weekly,
    resetsAt: hours(weeklyResetHours),
  },
];

const account = (
  id: string,
  model: string,
  limits: ServerProviderUsageWindow[],
): UsageLimitSourceAccount => ({
  id,
  driver: ProviderDriverKind.make("claudeAgent"),
  models: [model],
  usageLimits: { checkedAt: "2026-11-21T14:29:00.000Z", windows: limits },
});

const hub = (accounts: UsageLimitSourceAccount[]): UsageLimitSourceSnapshot[] => [
  {
    id: UsageLimitSourceId.make("hub"),
    kind: "cliproxy",
    label: "hub",
    checkedAt: "2026-11-21T14:29:00.000Z",
    accounts,
  },
];

const profile = (entries: PlacementProfile["entries"]): PlacementProfile => ({
  label: "Coding",
  entries,
});

const rank = (input: {
  entries: PlacementProfile["entries"];
  accounts: UsageLimitSourceAccount[];
  load?: (selection: ModelSelection) => PlacementLoad;
  policy?: Partial<typeof DEFAULT_PLACEMENT_POLICY>;
}) =>
  rankPlacementProfile({
    id: "coding",
    profile: profile(input.entries),
    policy: { ...DEFAULT_PLACEMENT_POLICY, ...input.policy },
    providers: [provider],
    sources: hub(input.accounts),
    now,
    load: input.load ?? (() => ({ running: 0 })),
  });

describe("rankPlacementProfile", () => {
  it("keeps the profile order while every account has room", () => {
    const decision = rank({
      entries: [
        { selection: one, enabled: true },
        { selection: david, enabled: true },
      ],
      accounts: [
        account("claude-1.json", one.model, windows(10, 20)),
        account("claude-david.json", david.model, windows(5, 10)),
      ],
    });
    expect(decision.next).toEqual(one);
    expect(decision.ranked.map((entry) => entry.state)).toEqual(["ok", "ok"]);
  });

  it("reads each gateway account from the hub account that routes its model", () => {
    const decision = rank({
      entries: [
        { selection: david, enabled: true },
        { selection: one, enabled: true },
      ],
      accounts: [
        account("claude-david.json", david.model, windows(97, 50)),
        account("claude-1.json", one.model, windows(10, 20)),
      ],
    });
    expect(decision.next).toEqual(one);
    expect(decision.ranked[1]).toMatchObject({ selection: david, state: "over_threshold" });
    expect(decision.ranked[0]?.session?.usedPercent).toBe(10);
  });

  it("puts an account first once its weekly allowance needs nearly every window left", () => {
    // claude-david on 2026-11-21: weekly at 74%, resetting in 19.5 hours, 13.7% per session.
    const decision = rank({
      entries: [
        { selection: one, enabled: true, sessionShareOfWeekly: 13.2 },
        { selection: david, enabled: true, sessionShareOfWeekly: 13.7 },
      ],
      accounts: [
        account("claude-1.json", one.model, windows(0, 65, 34.5)),
        account("claude-david.json", david.model, windows(9, 74, 19.5)),
      ],
    });
    expect(decision.next).toEqual(david);
    expect(decision.ranked[0]).toMatchObject({ state: "promoted", weeklySlackSessions: 2 });
    expect(decision.ranked[1]).toMatchObject({ state: "ok", weeklySlackSessions: 4.2 });
  });

  it("counts only active hours for the weekly rule when they are set", () => {
    expect(usableHours(now, now + 24 * 3_600_000)).toBe(24);
    const utc = DateTime.zoneMakeOffset(0);
    const midnight = Date.parse("2026-11-21T00:00:00.000Z");
    const day = midnight + 24 * 3_600_000;
    expect(usableHours(midnight, day, { start: 7, end: 24 }, utc)).toBe(17);
    expect(usableHours(midnight, day, { start: 22, end: 6 }, utc)).toBe(8);
  });

  it("starts the next thread elsewhere when the running ones would fill the session window", () => {
    const decision = rank({
      entries: [
        { selection: david, enabled: true },
        { selection: one, enabled: true },
      ],
      accounts: [
        account("claude-david.json", david.model, windows(50, 20)),
        account("claude-1.json", one.model, windows(10, 20)),
      ],
      load: (selection) =>
        selection.model === david.model
          ? { running: 2, burnPerThreadPerHour: 6 }
          : { running: 0, burnPerThreadPerHour: 6 },
    });
    // 50% + 6%/h × 3 threads × 3 h = 104%.
    expect(decision.next).toEqual(one);
    expect(decision.ranked[1]).toMatchObject({ selection: david, state: "full" });
    expect(decision.ranked[1]?.predictedSessionPercent).toBeCloseTo(104);
  });

  it("falls back to a full account rather than none", () => {
    const decision = rank({
      entries: [{ selection: david, enabled: true }],
      accounts: [account("claude-david.json", david.model, windows(80, 20))],
      load: () => ({ running: 3, burnPerThreadPerHour: 10 }),
    });
    expect(decision.next).toEqual(david);
  });

  it("skips turned-off and spent entries", () => {
    const decision = rank({
      entries: [
        { selection: david, enabled: false },
        { selection: one, enabled: true },
        { selection: alex, enabled: true },
      ],
      accounts: [
        account("claude-david.json", david.model, windows(0, 0)),
        account("claude-1.json", one.model, windows(100, 40)),
        account("claude-alex.json", alex.model, windows(30, 4)),
      ],
    });
    expect(decision.next).toEqual(alex);
    expect(decision.ranked.map((entry) => entry.state)).toEqual(["ok", "disabled", "exhausted"]);
  });

  it("reads a window whose reset has passed as unused", () => {
    const decision = rank({
      entries: [{ selection: david, enabled: true }],
      accounts: [
        account("claude-david.json", david.model, [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 100,
            resetsAt: hours(-1),
          },
        ]),
      ],
    });
    expect(decision.ranked[0]).toMatchObject({ state: "ok", session: { usedPercent: 0 } });
  });
});

describe("placementMoveTarget", () => {
  const decision = rank({
    entries: [
      { selection: david, enabled: true },
      { selection: one, enabled: true },
    ],
    accounts: [
      account("claude-david.json", david.model, windows(96, 50)),
      account("claude-1.json", one.model, windows(10, 20)),
    ],
  });

  it("moves a thread off an account past the switch point", () => {
    expect(placementMoveTarget(decision, david)).toMatchObject({ to: one });
  });

  it("leaves a thread on an account that can still run", () => {
    expect(placementMoveTarget(decision, one)).toBeNull();
  });

  it("moves a thread whose model is not in the profile", () => {
    expect(placementMoveTarget(decision, alex)?.reason).toContain("not part of");
  });
});

describe("placement tags", () => {
  it("round-trips the profile id", () => {
    expect(placementProfileOfTags(["x", placementTag("review")])).toBe("review");
    expect(placementProfileOfTags(["x"])).toBeNull();
  });
});

describe("placement provider", () => {
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    placementProfiles: { coding: profile([{ selection: david, enabled: true }]) },
  };

  it("lists one model per profile and replaces a stored snapshot under its id", () => {
    const stale = { ...provider, instanceId: PLACEMENT_INSTANCE_ID, status: "error" as const };
    const providers = withPlacementProvider([provider, stale], settings, "2026-11-21T14:00:00Z");
    expect(providers).toHaveLength(2);
    expect(providers[1]).toMatchObject({
      instanceId: PLACEMENT_INSTANCE_ID,
      displayName: "Profiles",
      status: "ready",
      models: [{ slug: "coding", name: "Coding", supportsTextGeneration: false }],
    });
  });

  it("is absent without profiles", () => {
    expect(withPlacementProvider([provider], DEFAULT_SERVER_SETTINGS, "x")).toEqual([provider]);
    expect(withPlacementInstanceSetting(DEFAULT_SERVER_SETTINGS)).toBe(DEFAULT_SERVER_SETTINGS);
  });

  it("turns the instance on for clients", () => {
    expect(withPlacementInstanceSetting(settings).providerInstances[PLACEMENT_INSTANCE_ID]).toEqual(
      expect.objectContaining({ enabled: true }),
    );
  });

  it("starts a pick on the ranked choice, else the first turned-on entry", () => {
    const coding = profile([
      { selection: david, enabled: false },
      { selection: one, enabled: true },
    ]);
    expect(placementPickSelection(null, coding)).toEqual(one);
    expect(placementPickSelection({ id: "c", label: "C", next: alex, ranked: [] }, coding)).toEqual(
      alex,
    );
    expect(placementPickSelection(null, undefined)).toBeNull();
  });
});
