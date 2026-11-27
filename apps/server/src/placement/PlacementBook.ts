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
  placementEntryKey,
  type PlacementLoad,
  rankPlacementProfile,
} from "@t3tools/shared/placement";
import * as Context from "effect/Context";

const HOUR = 3_600_000;
/** How far back session readings count toward an account's burn rate. */
const BURN_WINDOW_MS = 45 * 60_000;
const MIN_BURN_SPAN_MS = 10 * 60_000;
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
  const kept =
    last !== undefined && sample.used + 0.5 < last.used
      ? []
      : previous.filter((entry) => sample.at - entry.at <= BURN_WINDOW_MS);
  const samples = [...kept, sample];
  book.samples.set(key, samples);
  const first = samples[0]!;
  const span = sample.at - first.at;
  const meanRunning = samples.reduce((total, entry) => total + entry.running, 0) / samples.length;
  if (span >= MIN_BURN_SPAN_MS && meanRunning >= 0.5) {
    const perThread = (sample.used - first.used) / (span / HOUR) / meanRunning;
    const smoothed = book.burn.has(key)
      ? 0.5 * book.burn.get(key)! + 0.5 * Math.max(0, perThread)
      : Math.max(0, perThread);
    book.burn.set(key, smoothed);
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

export function decideProfile(
  book: PlacementBook,
  input: {
    readonly profileId: string;
    readonly settings: ServerSettings;
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly now: number;
    readonly projectId?: ProjectId | null;
  },
): PlacementProfileDecision | null {
  if (book.remoteCheckedAt > 0 && input.now - book.remoteCheckedAt < REMOTE_DECISION_TTL_MS) {
    const remote = book.remoteDecisions.get(input.profileId);
    if (remote !== undefined) return remote;
  }
  const profile = input.settings.placementProfiles[input.profileId];
  if (profile === undefined) return null;
  return rankPlacementProfile({
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
}
