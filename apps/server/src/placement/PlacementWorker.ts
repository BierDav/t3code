import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  type RunId,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import {
  placementEntryKey,
  placementMoveTarget,
  placementProfileOfTags,
  placementSelectionOutOfUsage,
  placementWaitsForReset,
  placementWindows,
  sameEntry,
} from "@t3tools/shared/placement";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
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
  recordRemoteDecisions,
  recordSessionSample,
} from "./PlacementBook.ts";
import {
  buildPrismSyncRequest,
  decisionsFromPrismResponse,
  type PrismMoveAck,
  type PrismSyncResponse,
  profilesFromPrismResponse,
  syncWithPrism,
} from "./prismSync.ts";

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
  readonly prismMoveId?: string | undefined;
  readonly stage: "interrupting" | "compacting";
  readonly compactRunId?: RunId | undefined;
}

const label = (selection: ModelSelection) => selection.model;

export function shortAccountLabel(selection: ModelSelection) {
  const slash = selection.model.indexOf("/");
  return slash > 0 ? selection.model.slice(0, slash) : selection.model;
}

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

function profileThreadFingerprint(threads: ReadonlyArray<OrchestrationV2ThreadShell>): string {
  const parts: string[] = [];
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const profileId = placementProfileOfTags(thread.tags);
    if (profileId === null) continue;
    parts.push(`${thread.id}:${profileId}:${isLive(thread) ? "1" : "0"}`);
  }
  return parts.join("|");
}

export const makePlacementSweep = Effect.fn("PlacementWorker.makeSweep")(function* (options?: {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly nowMs?: (() => number) | undefined;
}) {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const usageSources = yield* UsageLimitSources.UsageLimitSources;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const engine = yield* Orchestrator.OrchestratorV2;
  const fs = yield* FileSystem.FileSystem;
  const envIdentity = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironmentIdentity);
  const eventSink = yield* Effect.serviceOption(EventSink.EventSinkV2);
  const book: PlacementBook = yield* PlacementBookRef;
  const pending = new Map<ThreadId, PendingMove>();
  const handledFailures = new Set<string>();
  const pendingAcks: PrismMoveAck[] = [];
  const handledPrismMoves = new Set<string>();
  let lastSweepMs = 0;
  let lastPrismAnswerMs = 0;
  let lastProfileFingerprint = "";

  const recordMoveNotice = Effect.fnUntraced(function* (
    thread: OrchestrationV2ThreadShell,
    move: {
      readonly runId: RunId | null;
      readonly from: ModelSelection;
      readonly to: ModelSelection;
      readonly reason: string;
      readonly at: string;
    },
  ) {
    if (Option.isNone(eventSink)) return;
    const now = DateTime.makeUnsafe(move.at);
    const key = `${thread.id}:${move.runId ?? "idle"}:${move.at}`;
    yield* eventSink.value
      .write({
        events: [
          {
            id: EventId.make(`event:placement-move-notice:${key}`),
            type: "turn-item.updated",
            threadId: thread.id,
            ...(move.runId === null ? {} : { runId: move.runId }),
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`item:placement-move-notice:${key}`),
              threadId: thread.id,
              runId: move.runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: "completed",
              title: `${shortAccountLabel(move.from)} → ${shortAccountLabel(move.to)}`,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "system_notice",
              message: move.reason,
            },
          },
        ],
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("placement.move-notice-failed", { threadId: thread.id, cause }),
        ),
      );
  });

  const notifyParent = Effect.fnUntraced(function* (
    thread: OrchestrationV2ThreadShell,
    move: Omit<PendingMove, "stage" | "compactRunId">,
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
    move: Omit<PendingMove, "stage" | "compactRunId">,
  ) {
    const key = `${thread.id}:${move.runId}`;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`placement-move:${key}`),
      messageId: MessageId.make(`placement-move:${key}`),
      threadId: thread.id,
      modelSelection: move.to,
      text: continuationText(move.from, move.to, move.reason),
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "server",
    });
    recordMove(book, { threadId: thread.id, ...move, state: "continued" });
    if (move.prismMoveId !== undefined) {
      pendingAcks.push({ id: move.prismMoveId, state: "continued" });
    }
    yield* recordMoveNotice(thread, move);
    yield* notifyParent(thread, move).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("placement.parent-notice-failed", { threadId: thread.id, cause }),
      ),
    );
  });

  return Effect.fn("PlacementWorker.sweep")(function* () {
    const nowMs = options?.nowMs ? options.nowMs() : DateTime.toEpochMillis(yield* DateTime.now);
    const settings = yield* settingsService.getSettings;
    const source = settings.placementSource;
    const prismEnabled = source !== null && source.enabled;
    const shell = yield* projections.getShellSnapshot({ location: "active" });
    const fingerprint = profileThreadFingerprint(shell.threads);
    const profileStateChanged = fingerprint !== lastProfileFingerprint;
    const dueByInterval = nowMs - lastSweepMs >= SWEEP_EVERY_MS;
    const dueByPrismEvent =
      prismEnabled && profileStateChanged && nowMs - lastPrismAnswerMs >= SWEEP_EVERY_MS;
    if (!dueByInterval && !dueByPrismEvent) return;
    lastSweepMs = nowMs;
    lastProfileFingerprint = fingerprint;

    if (!prismEnabled && Object.keys(settings.placementProfiles).length === 0) {
      pending.clear();
      return;
    }
    const providers = yield* registry.getProviders;
    book.sources = yield* usageSources.current;
    book.checkedAt = nowMs;

    let activeSettings = settings;
    let prismResponse: PrismSyncResponse | null = null;
    if (prismEnabled) {
      const environmentId = Option.isSome(envIdentity)
        ? yield* envIdentity.value.getEnvironmentId
        : "local";
      const acksToSend = pendingAcks.slice();
      const body = buildPrismSyncRequest({
        environmentId,
        providers,
        sources: book.sources,
        settings,
        threads: shell.threads,
        isLive,
        moves: acksToSend,
        nowMs,
      });
      prismResponse = yield* syncWithPrism({
        source,
        body,
        fs,
        fetchImpl: options?.fetchImpl,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("placement.prism-sync-failed", { cause }).pipe(Effect.as(null)),
        ),
      );
      if (prismResponse !== null) {
        pendingAcks.splice(0, acksToSend.length);
        lastPrismAnswerMs = nowMs;
        recordRemoteDecisions(book, decisionsFromPrismResponse(prismResponse), nowMs);
        const nextProfiles = profilesFromPrismResponse(prismResponse);
        const nextPolicy = prismResponse.policy ?? settings.placementPolicy;
        if (
          !Equal.equals(nextProfiles, settings.placementProfiles) ||
          !Equal.equals(nextPolicy, settings.placementPolicy)
        ) {
          const updated = yield* settingsService
            .updateSettings({
              placementProfiles: nextProfiles,
              ...(prismResponse.policy === undefined ? {} : { placementPolicy: nextPolicy }),
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("placement.prism-settings-update-failed", { cause }).pipe(
                  Effect.as(activeSettings),
                ),
              ),
            );
          activeSettings = updated;
        }
      }
    }

    // Load: every live run counts against its account, whatever started it.
    book.running.clear();
    for (const thread of shell.threads) {
      if (!isLive(thread)) continue;
      const key = placementEntryKey(thread.modelSelection);
      book.running.set(key, (book.running.get(key) ?? 0) + 1);
    }
    const entries = new Map<string, ModelSelection>();
    for (const profile of Object.values(activeSettings.placementProfiles)) {
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

    // Finish any in-flight interrupt-and-continue moves first.
    for (const thread of shell.threads) {
      const waiting = pending.get(thread.id);
      if (waiting === undefined) continue;
      if (waiting.stage === "compacting") {
        if (isLive(thread) && nowMs - waiting.startedMs <= INTERRUPT_TIMEOUT_MS) {
          continue;
        }
        pending.delete(thread.id);
        yield* continueOn(thread, waiting).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              recordMove(book, { threadId: thread.id, ...waiting, state: "failed" });
              if (waiting.prismMoveId !== undefined) {
                pendingAcks.push({
                  id: waiting.prismMoveId,
                  state: "failed",
                  detail: "continue failed",
                });
              }
              yield* Effect.logWarning("placement.continue-failed", {
                threadId: thread.id,
                cause,
              });
            }),
          ),
        );
        continue;
      }
      if (thread.activeRunId === waiting.runId && isLive(thread)) {
        if (nowMs - waiting.startedMs > INTERRUPT_TIMEOUT_MS) {
          pending.delete(thread.id);
          recordMove(book, { threadId: thread.id, ...waiting, state: "failed" });
          if (waiting.prismMoveId !== undefined) {
            pendingAcks.push({
              id: waiting.prismMoveId,
              state: "failed",
              detail: "interrupt timed out",
            });
          }
        }
        continue;
      }
      pending.delete(thread.id);
      if (
        thread.latestRunId === waiting.runId &&
        (thread.status === "interrupted" || thread.status === "failed")
      ) {
        // Compaction runs on the account being left, so it is skipped when that one is spent.
        if (
          thread.status === "interrupted" &&
          !placementSelectionOutOfUsage(waiting.from, providers, book.sources, nowMs)
        ) {
          const compactKey = `${thread.id}:${waiting.runId}`;
          const compacted = yield* threads
            .dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`placement-compact:${compactKey}`),
              messageId: MessageId.make(`placement-compact:${compactKey}`),
              threadId: thread.id,
              modelSelection: waiting.from,
              text: "/compact",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "server",
            })
            .pipe(
              Effect.as(true),
              Effect.catchCause((cause) =>
                Effect.logWarning("placement.compact-failed", {
                  threadId: thread.id,
                  cause,
                }).pipe(Effect.as(false)),
              ),
            );
          if (compacted) {
            pending.set(thread.id, { ...waiting, stage: "compacting", startedMs: nowMs });
            continue;
          }
        }
        yield* continueOn(thread, waiting).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              recordMove(book, { threadId: thread.id, ...waiting, state: "failed" });
              if (waiting.prismMoveId !== undefined) {
                pendingAcks.push({
                  id: waiting.prismMoveId,
                  state: "failed",
                  detail: "continue failed",
                });
              }
              yield* Effect.logWarning("placement.continue-failed", {
                threadId: thread.id,
                cause,
              });
            }),
          ),
        );
      } else if (waiting.prismMoveId !== undefined) {
        pendingAcks.push({
          id: waiting.prismMoveId,
          state: "failed",
          detail: `run ended with status ${thread.status}`,
        });
      }
    }

    // When Prism answered, carry out its move instructions instead of local move decisions.
    if (prismResponse !== null) {
      const threadsById = new Map(shell.threads.map((thread) => [thread.id, thread]));
      for (const prismMove of prismResponse.moves ?? []) {
        if (handledPrismMoves.has(prismMove.id)) continue;
        const thread = threadsById.get(prismMove.threadId as ThreadId);
        if (thread === undefined || thread.archivedAt !== null || pending.has(thread.id)) {
          continue;
        }
        handledPrismMoves.add(prismMove.id);
        const at = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
        if (isLive(thread) && thread.activeRunId !== null) {
          const move: PendingMove = {
            runId: thread.activeRunId,
            from: prismMove.from,
            to: prismMove.to,
            reason: prismMove.reason,
            at,
            startedMs: nowMs,
            prismMoveId: prismMove.id,
            stage: "interrupting",
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
                Effect.logWarning("placement.interrupt-failed", {
                  threadId: thread.id,
                  cause,
                }).pipe(Effect.as(false)),
              ),
            );
          if (!interrupted) {
            pendingAcks.push({ id: prismMove.id, state: "failed", detail: "interrupt failed" });
            continue;
          }
          pending.set(thread.id, move);
          recordMove(book, { threadId: thread.id, ...move, state: "interrupting" });
        } else if (
          thread.status === "failed" &&
          thread.lastErrorClass === "usage_limit" &&
          thread.latestRunId !== null &&
          thread.pendingRuntimeRequest === null
        ) {
          const profileId = placementProfileOfTags(thread.tags);
          const decision =
            profileId === null
              ? null
              : decideProfile(book, {
                  profileId,
                  settings: activeSettings,
                  providers,
                  now: nowMs,
                  projectId: thread.projectId,
                });
          if (
            decision !== null &&
            placementWaitsForReset({
              decision,
              policy: activeSettings.placementPolicy,
              current: thread.modelSelection,
              failedAtMs: DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt),
              resetAtMs: Date.parse(thread.usageLimitResetAt ?? ""),
            })
          ) {
            // The local loop below resumes it on its own account once the limit resets.
            pendingAcks.push({
              id: prismMove.id,
              state: "failed",
              detail: "waits for its usage limit to reset on the same account",
            });
            continue;
          }
          // The local usage-limit continuation below must not continue it a second time.
          handledFailures.add(`${thread.id}:${thread.latestRunId}`);
          yield* continueOn(thread, {
            runId: thread.latestRunId,
            from: prismMove.from,
            to: prismMove.to,
            reason: prismMove.reason,
            at,
            startedMs: nowMs,
            prismMoveId: prismMove.id,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                pendingAcks.push({
                  id: prismMove.id,
                  state: "failed",
                  detail: "continue failed",
                });
                yield* Effect.logWarning("placement.limit-move-failed", {
                  threadId: thread.id,
                  cause,
                });
              }),
            ),
          );
        } else {
          yield* threads
            .dispatch({
              type: "thread.model-selection.set",
              commandId: CommandId.make(`placement-move-idle:${prismMove.id}`),
              threadId: thread.id,
              modelSelection: prismMove.to,
            })
            .pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  recordMove(book, {
                    threadId: thread.id,
                    from: prismMove.from,
                    to: prismMove.to,
                    reason: prismMove.reason,
                    at,
                    state: "continued",
                  });
                  pendingAcks.push({ id: prismMove.id, state: "continued" });
                  yield* recordMoveNotice(thread, {
                    runId: thread.latestRunId,
                    from: prismMove.from,
                    to: prismMove.to,
                    reason: prismMove.reason,
                    at,
                  });
                }),
              ),
              Effect.catchCause((cause) =>
                Effect.gen(function* () {
                  pendingAcks.push({
                    id: prismMove.id,
                    state: "failed",
                    detail: "model selection update failed",
                  });
                  yield* Effect.logWarning("placement.idle-move-failed", {
                    threadId: thread.id,
                    cause,
                  });
                }),
              ),
            );
        }
      }
    }

    // While Prism answers, it decides the moves of live runs. A run that just failed on a
    // usage limit still continues here at once: the failure is news Prism's usage readings
    // may not show yet.
    const prismDecidesMoves = prismResponse !== null;
    for (const thread of shell.threads) {
      const profileId = placementProfileOfTags(thread.tags);
      if (profileId === null || thread.archivedAt !== null || pending.has(thread.id)) continue;
      const decision = decideProfile(book, {
        profileId,
        settings: activeSettings,
        providers,
        now: nowMs,
        projectId: thread.projectId,
      });
      if (decision === null) continue;

      // A limit that resets soon is waited for on the same account, which keeps its prompt
      // cache, unless another account must take work before its weekly allowance is wasted.
      if (
        !isLive(thread) &&
        thread.status === "failed" &&
        thread.lastErrorClass === "usage_limit" &&
        thread.latestRunId !== null &&
        thread.pendingRuntimeRequest === null &&
        placementWaitsForReset({
          decision,
          policy: activeSettings.placementPolicy,
          current: thread.modelSelection,
          failedAtMs: DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt),
          resetAtMs: Date.parse(thread.usageLimitResetAt ?? ""),
        })
      ) {
        const resetAtMs = Date.parse(thread.usageLimitResetAt ?? "");
        if (nowMs < resetAtMs || nowMs - resetAtMs > LIMIT_FAILURE_WINDOW_MS) continue;
        const failureKey = `${thread.id}:${thread.latestRunId}`;
        if (handledFailures.has(failureKey)) continue;
        handledFailures.add(failureKey);
        yield* threads
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`placement-resume:${failureKey}`),
            messageId: MessageId.make(`placement-resume:${failureKey}`),
            threadId: thread.id,
            usageLimitContinuationOfRunId: thread.latestRunId,
            modelSelection: thread.modelSelection,
            text: "Continue where you left off. Your usage limit has reset.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "server",
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("placement.limit-resume-failed", { threadId: thread.id, cause }),
            ),
          );
        continue;
      }

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
      if (prismDecidesMoves || !isLive(thread) || thread.activeRunId === null) continue;
      const target = placementMoveTarget(decision, thread.modelSelection);
      if (target === null) continue;
      const move: PendingMove = {
        runId: thread.activeRunId,
        from: thread.modelSelection,
        to: target.to,
        reason: target.reason,
        at: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
        startedMs: nowMs,
        stage: "interrupting",
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
    const sweep = yield* makePlacementSweep();
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("placement", sweep());
  }),
);
