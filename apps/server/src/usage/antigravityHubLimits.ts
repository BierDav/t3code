// Fork patch (antigravity-hub-limits): upstream stopped reading Antigravity limits so T3 no longer
// calls Google's internal APIs. Only the CLIProxy hub path is kept: the hub asks Google, not T3.
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const ANTIGRAVITY_SUMMARY_URL =
  "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";

const SUMMARY_WINDOW_MINS = new Map([
  ["5h", 5 * 60],
  ["weekly", 7 * 24 * 60],
]);

const Bucket = Schema.Struct({
  bucketId: Schema.NonEmptyString,
  remainingFraction: Schema.optional(Schema.Number),
  resetTime: Schema.optional(Schema.String),
  window: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
});
const Summary = Schema.Struct({
  groups: Schema.optional(
    Schema.Array(
      Schema.Struct({
        displayName: Schema.optional(Schema.String),
        buckets: Schema.optional(Schema.Array(Bucket)),
      }),
    ),
  ),
  buckets: Schema.optional(Schema.Array(Bucket)),
});
const decodeSummary = Schema.decodeUnknownEffect(Schema.fromJsonString(Summary));

function iso(value: string | undefined): string | undefined {
  const parsed = value ? DateTime.make(value) : Option.none();
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

// Untouched buckets report a rolling full-window reset, which is not a real refill time.
function resetTime(
  bucket: typeof Bucket.Type,
  windowMins: number | undefined,
  requestedAt: number,
) {
  const untouched =
    bucket.remainingFraction === 1 &&
    bucket.description === undefined &&
    windowMins !== undefined &&
    Math.abs(Date.parse(bucket.resetTime ?? "") - requestedAt - windowMins * 60_000) <= 60_000;
  return untouched ? undefined : iso(bucket.resetTime);
}

// Argon and Carbon are metered apart from the other Gemini buckets; "3p-" buckets are Claude and GPT.
function family(bucket: typeof Bucket.Type, group: string | undefined) {
  if (bucket.bucketId.startsWith("gemini-argon-")) return group || "Gemini Argon";
  if (bucket.bucketId.startsWith("gemini-carbon-")) return group || "Gemini Carbon";
  if (bucket.bucketId.startsWith("gemini-")) return "Gemini";
  if (bucket.bucketId.startsWith("3p-")) return "Claude & GPT (shared)";
  return group || bucket.bucketId;
}

/** Windows from a `retrieveUserQuotaSummary` answer (JSON text) requested at `requestedAt`. */
export const antigravitySummaryWindows = (body: string, requestedAt: number) =>
  decodeSummary(body).pipe(
    Effect.map((summary) => {
      const windows = new Map<string, ServerProviderUsageWindow>();
      const groups = summary.groups?.some((group) => group.buckets?.length)
        ? summary.groups
        : [{ displayName: undefined, buckets: summary.buckets }];
      for (const group of groups) {
        for (const bucket of group.buckets ?? []) {
          const remaining = bucket.remainingFraction;
          if (bucket.disabled || remaining === undefined || !Number.isFinite(remaining)) continue;
          const weekly = bucket.window === "weekly";
          const session = bucket.window === "5h";
          const windowDurationMins = SUMMARY_WINDOW_MINS.get(bucket.window ?? "");
          const resetsAt = resetTime(bucket, windowDurationMins, requestedAt);
          const period = weekly
            ? "Weekly"
            : session
              ? "5-hour"
              : bucket.displayName?.trim() || "Quota";
          windows.set(bucket.bucketId, {
            id: bucket.bucketId,
            label: `${family(bucket, group.displayName?.trim())} · ${period}`,
            kind: weekly ? "weekly" : session ? "session" : "other",
            usedPercent: (1 - Math.max(0, Math.min(1, remaining))) * 100,
            ...(resetsAt ? { resetsAt } : {}),
            ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
          });
        }
      }
      return [...windows.values()];
    }),
  );
