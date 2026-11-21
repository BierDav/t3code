import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/** A thread runs in a placement profile while it carries the tag `placement:<id>`. */
export const PLACEMENT_TAG_PREFIX = "placement:";

export const PlacementProfileId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(40),
  Schema.makeFilter((value) =>
    /^[a-z0-9][a-z0-9-]*$/.test(value)
      ? true
      : "A placement profile id uses lowercase letters, digits and dashes.",
  ),
);
export type PlacementProfileId = typeof PlacementProfileId.Type;

export const PlacementEntry = Schema.Struct({
  selection: ModelSelection,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * The share of the weekly window, in percent, that one fully used session (5-hour) window
   * costs on this account. Turns on the weekly rule for it; without it only the order and the
   * session window decide.
   */
  sessionShareOfWeekly: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 0.1, maximum: 100 })),
  ),
});
export type PlacementEntry = typeof PlacementEntry.Type;

export const PlacementProfile = Schema.Struct({
  label: TrimmedNonEmptyString,
  /** In order of preference. */
  entries: Schema.Array(PlacementEntry),
});
export type PlacementProfile = typeof PlacementProfile.Type;

export const PlacementActiveHours = Schema.Struct({
  /** Local hour the day's work starts, 0–23. */
  start: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 23 })),
  /** Local hour it ends, 1–24; an end before the start spans midnight. */
  end: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 24 })),
});
export type PlacementActiveHours = typeof PlacementActiveHours.Type;

export const PlacementPolicy = Schema.Struct({
  /** A thread moves off an account once a window that limits its model reaches this percent. */
  switchAtPercent: Schema.Number.check(Schema.isBetween({ minimum: 50, maximum: 100 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(95)),
  ),
  /**
   * An account goes first, ahead of the profile's order, once its remaining weekly allowance
   * needs all but this many of the session windows left before the weekly reset.
   */
  weeklySlackSessions: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 20 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(3)),
  ),
  /** Hours in which session windows count as usable for the weekly rule. Absent: every hour. */
  activeHours: Schema.optional(PlacementActiveHours),
  /** `delegate_task` role to profile. A role not listed inherits the parent thread's profile. */
  roleProfiles: Schema.Record(Schema.String, PlacementProfileId).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type PlacementPolicy = typeof PlacementPolicy.Type;

export const DEFAULT_PLACEMENT_POLICY: PlacementPolicy = {
  switchAtPercent: 95,
  weeklySlackSessions: 3,
  roleProfiles: {},
};

export const PlacementProfiles = Schema.Record(PlacementProfileId, PlacementProfile);
export type PlacementProfiles = typeof PlacementProfiles.Type;

export const PlacementEntryState = Schema.Literals([
  "ok",
  "promoted",
  "full",
  "over_threshold",
  "exhausted",
  "disabled",
  "unavailable",
]);
export type PlacementEntryState = typeof PlacementEntryState.Type;

export const PlacementWindowReading = Schema.Struct({
  usedPercent: Schema.Number,
  resetsAt: Schema.optional(Schema.String),
});

/** One entry of a profile as the scheduler sees it now. */
export const PlacementEntryDecision = Schema.Struct({
  selection: ModelSelection,
  state: PlacementEntryState,
  reason: Schema.String,
  session: Schema.optional(PlacementWindowReading),
  weekly: Schema.optional(PlacementWindowReading),
  /** Session windows to spare before the weekly reset; absent without `sessionShareOfWeekly`. */
  weeklySlackSessions: Schema.optional(Schema.Number),
  runningThreads: Schema.Number,
  /** Session percent this account is expected to reach by its reset with one more thread. */
  predictedSessionPercent: Schema.optional(Schema.Number),
});
export type PlacementEntryDecision = typeof PlacementEntryDecision.Type;

export const PlacementProfileDecision = Schema.Struct({
  id: PlacementProfileId,
  label: Schema.String,
  /** What a new thread in this profile starts on; null when no entry can run. */
  next: Schema.NullOr(ModelSelection),
  /** Entries in the order the scheduler tries them. */
  ranked: Schema.Array(PlacementEntryDecision),
});
export type PlacementProfileDecision = typeof PlacementProfileDecision.Type;

export const PlacementMove = Schema.Struct({
  threadId: Schema.String,
  from: ModelSelection,
  to: ModelSelection,
  reason: Schema.String,
  at: Schema.String,
  state: Schema.Literals(["interrupting", "continued", "failed"]),
});
export type PlacementMove = typeof PlacementMove.Type;

export const PlacementSnapshot = Schema.Struct({
  checkedAt: Schema.String,
  profiles: Schema.Array(PlacementProfileDecision),
  /** The latest moves, newest first. */
  moves: Schema.Array(PlacementMove),
});
export type PlacementSnapshot = typeof PlacementSnapshot.Type;
