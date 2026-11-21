import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  placementEntryKey,
  placementMoveTarget,
  placementProfileOfTags,
  placementWindows,
  sameEntry,
} from "@t3tools/shared/placement";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import {
  decideProfile,
  type PlacementBook,
  PlacementBookRef,
  recordMove,
  recordSessionSample,
} from "./PlacementBook.ts";

const SWEEP_EVERY_MS = 30_000;
/** A usage-limit failure this recent is moved; older ones are left to limit recovery. */
const LIMIT_FAILURE_WINDOW_MS = 10 * 60_000;
/** An interrupt that has not ended its run by then is given up, so the thread can be retried. */
const INTERRUPT_TIMEOUT_MS = 3 * 60_000;

interface PendingMove {
  readonly runId: RunId;
  readonly from: ModelSelection;
  readonly to: ModelSelection;
  readonly reason: string;
  readonly at: string;
  readonly startedMs: number;
}

const label = (selection: ModelSelection) => selection.model;

export function continuationText(from: ModelSelection, to: ModelSelection, reason: string) {
  return `Continue where you left off. Your work moved from ${label(from)} to ${label(to)}: ${reason.replace(/\.$/, "")}. Your earlier progress is above; check what the last step finished before you repeat it.`;
}

export function parentNoticeText(
  child: ThreadId,
  from: ModelSelection,
  to: ModelSelection,
  reason: string,
) {
  return `Placement moved delegated thread ${child} from ${label(from)} to ${label(to)} (${reason.replace(/\.$/, "")}). It continues on its own with its context handed over; no action is needed. Its result arrives as usual.`;
}

const isLive = (thread: OrchestrationV2ThreadShell) =>
  thread.activeRunId !== null &&
  (thread.status === "running" || thread.status === "starting" || thread.status === "waiting");

const makeSweep = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const usageSources = yield* UsageLimitSources.UsageLimitSources;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const engine = yield* Orchestrator.OrchestratorV2;
  const book: PlacementBook = yield* PlacementBookRef;
  const pending = new Map<ThreadId, PendingMove>();
  const handledFailures = new Set<string>();
  let lastSweepMs = 0;

  const notifyParent = Effect.fnUntraced(function* (
    thread: OrchestrationV2ThreadShell,
    move: PendingMove,
  ) {
    const parentId = thread.lineage.parentThreadId;
    if (parentId === null || thread.lineage.relationshipToParent !== "subagent") return;
    const parent = yield* projections.getThreadRecords(parentId, ["subagents"]);
    const task = parent.subagents.find(
      (candidate) => candidate.origin === "app_owned" && candidate.childThreadId === thread.id,
    );
    if (task === undefined || parent.thread.archivedAt !== null) return;
    const key = `${thread.id}:${move.runId}`;
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:placement-parent-notice:${key}`),
      threadId: parentId,
      messageId: MessageId.make(`message:placement-parent-notice:${key}`),
      text: parentNoticeText(thread.id, move.from, move.to, move.reason),
      notification: {
        source: { kind: "delegated_task", taskIds: [task.id], childThreadId: thread.id },
        outcome: "updated",
        summary: `Delegated task moved to ${label(move.to)}`,
      },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
  });

  const continueOn = Effect.fnUntraced(function* (
    thread: OrchestrationV2ThreadShell,
    move: PendingMove,
  ) {
    const key = `${thread.id}:${move.runId}`;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`placement-move:${key}`),
      messageId: MessageId.make(`placement-move:${key}`),
      threadId: thread.id,
      manualContinuationOfRunId: move.runId,
      modelSelection: move.to,
      text: continuationText(move.from, move.to, move.reason),
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "server",
    });
    recordMove(book, { threadId: thread.id, ...move, state: "continued" });
    yield* notifyParent(thread, move).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("placement.parent-notice-failed", { threadId: thread.id, cause }),
      ),
    );
  });

  return Effect.fn("PlacementWorker.sweep")(function* () {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (nowMs - lastSweepMs < SWEEP_EVERY_MS) return;
    lastSweepMs = nowMs;
    const settings = yield* settingsService.getSettings;
    if (Object.keys(settings.placementProfiles).length === 0) {
      pending.clear();
      return;
    }
    const providers = yield* registry.getProviders;
    book.sources = yield* usageSources.current;
    book.checkedAt = nowMs;
    const shell = yield* projections.getShellSnapshot({ location: "active" });

    // Load: every live run counts against its account, whatever started it.
    book.running.clear();
    for (const thread of shell.threads) {
      if (!isLive(thread)) continue;
      const key = placementEntryKey(thread.modelSelection);
      book.running.set(key, (book.running.get(key) ?? 0) + 1);
    }
    const entries = new Map<string, ModelSelection>();
    for (const profile of Object.values(settings.placementProfiles)) {
      for (const entry of profile.entries)
        entries.set(placementEntryKey(entry.selection), entry.selection);
    }
    for (const [key, selection] of entries) {
      const windows = placementWindows(selection, providers, book.sources, nowMs);
      const session = windows?.find((window) => window.kind === "session");
      if (session === undefined) continue;
      recordSessionSample(book, key, {
        at: nowMs,
        used: session.usedPercent,
        running: book.running.get(key) ?? 0,
      });
    }

    for (const thread of shell.threads) {
      const profileId = placementProfileOfTags(thread.tags);
      if (profileId === null || thread.archivedAt !== null) continue;
      const waiting = pending.get(thread.id);
      if (waiting !== undefined) {
        if (thread.activeRunId === waiting.runId && isLive(thread)) {
          if (nowMs - waiting.startedMs > INTERRUPT_TIMEOUT_MS) {
            pending.delete(thread.id);
            recordMove(book, { threadId: thread.id, ...waiting, state: "failed" });
          }
          continue;
        }
        pending.delete(thread.id);
        if (
          thread.latestRunId === waiting.runId &&
          (thread.status === "interrupted" || thread.status === "failed")
        ) {
          yield* continueOn(thread, waiting).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                recordMove(book, { threadId: thread.id, ...waiting, state: "failed" });
                yield* Effect.logWarning("placement.continue-failed", {
                  threadId: thread.id,
                  cause,
                });
              }),
            ),
          );
        }
        continue;
      }
      const decision = decideProfile(book, {
        profileId,
        settings,
        providers,
        now: nowMs,
        projectId: thread.projectId,
      });
      if (decision === null) continue;

      // A run that just failed on a usage limit continues on the next account straight away.
      if (
        !isLive(thread) &&
        thread.status === "failed" &&
        thread.lastErrorClass === "usage_limit" &&
        thread.latestRunId !== null &&
        thread.pendingRuntimeRequest === null &&
        nowMs - DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt) <=
          LIMIT_FAILURE_WINDOW_MS
      ) {
        const failureKey = `${thread.id}:${thread.latestRunId}`;
        if (handledFailures.has(failureKey)) continue;
        handledFailures.add(failureKey);
        const exhausted = {
          ...decision,
          ranked: decision.ranked.map((entry) =>
            sameEntry(entry.selection, thread.modelSelection)
              ? { ...entry, state: "exhausted" as const, reason: "It hit its usage limit." }
              : entry,
          ),
        };
        const target = placementMoveTarget(exhausted, thread.modelSelection);
        if (target === null) continue;
        yield* continueOn(thread, {
          runId: thread.latestRunId,
          from: thread.modelSelection,
          to: target.to,
          reason: target.reason,
          at: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
          startedMs: nowMs,
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("placement.limit-move-failed", { threadId: thread.id, cause }),
          ),
        );
        continue;
      }

      // A live run on an account past its switch point is stopped mid-turn and continued.
      if (!isLive(thread) || thread.activeRunId === null) continue;
      const target = placementMoveTarget(decision, thread.modelSelection);
      if (target === null) continue;
      const move: PendingMove = {
        runId: thread.activeRunId,
        from: thread.modelSelection,
        to: target.to,
        reason: target.reason,
        at: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
        startedMs: nowMs,
      };
      const interrupted = yield* threads
        .dispatch({
          type: "run.interrupt",
          commandId: CommandId.make(`placement-interrupt:${thread.id}:${move.runId}`),
          threadId: thread.id,
          runId: move.runId,
          reason: `Placement: moving to ${label(move.to)}. ${move.reason}`,
        })
        .pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("placement.interrupt-failed", { threadId: thread.id, cause }).pipe(
              Effect.as(false),
            ),
          ),
        );
      if (!interrupted) continue;
      pending.set(thread.id, move);
      recordMove(book, { threadId: thread.id, ...move, state: "interrupting" });
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("placement", sweep());
  }),
);
