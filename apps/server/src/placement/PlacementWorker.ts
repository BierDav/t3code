import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  PLACEMENT_COMPACTION_MESSAGE_ID_PREFIX,
  type PlacementSourceConfig,
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
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { queuedRunsInDeliveryOrder } from "../orchestration-v2/QueuedRunOrder.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
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
  decodePrismStreamResponse,
  type PrismMoveAck,
  type PrismSyncResponse,
  profilesFromPrismResponse,
  syncOverStream,
  syncWithPrism,
} from "./prismSync.ts";
import {
  openPrismStream,
  type PrismSocketFactory,
  type PrismStream,
  PrismStreamError,
} from "./prismStream.ts";

const SWEEP_EVERY_MS = 30_000;
/** A usage-limit failure this recent is moved; older ones are left to limit recovery. */
const LIMIT_FAILURE_WINDOW_MS = 10 * 60_000;
/** A Prism stream failure is logged at most this often. */
const STREAM_ERROR_LOG_EVERY_MS = 10 * 60_000;

interface Move {
  readonly runId: RunId;
  readonly from: ModelSelection;
  readonly to: ModelSelection;
  readonly reason: string;
  readonly at: string;
  readonly prismMoveId?: string | undefined;
}

/** A move carried by the thread's queue: `/compact` on `from`, then the continuation on `to`. */
interface QueuedMove extends Move {
  readonly compactMessageId: MessageId | null;
  readonly continueMessageId: MessageId;
}

/** What wakes the placement worker between its scheduled sweeps. */
export type PlacementTrigger =
  | { readonly kind: "pushed"; readonly response: unknown }
  | { readonly kind: "connected" }
  | { readonly kind: "stream-error"; readonly cause: unknown };

const label = (selection: ModelSelection) => selection.model;

export function shortAccountLabel(selection: ModelSelection) {
  const slash = selection.model.indexOf("/");
  return slash > 0 ? selection.model.slice(0, slash) : selection.model;
}

/** A move onto the account the thread is on: compact there and keep going (Prism asks it before a limit the account runs into on purpose). */
const inPlace = (move: { readonly from: ModelSelection; readonly to: ModelSelection }) =>
  sameEntry(move.from, move.to);

export function continuationText(from: ModelSelection, to: ModelSelection, reason: string) {
  if (inPlace({ from, to })) {
    return `Continue where you left off. Placement compacted this thread on ${label(to)}: ${reason.replace(/\.$/, "")}. Your earlier progress is above; check what the last step finished before you repeat it.`;
  }
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

// The shell's status is its newest unheld run's: a message queued behind the active run takes it
// over while that run still works. The active run's own status says whether it is live.
const isLive = (thread: OrchestrationV2ThreadShell) => {
  const status = thread.activityRunStatus ?? thread.status;
  return (
    thread.activeRunId !== null &&
    (status === "running" || status === "starting" || status === "waiting")
  );
};

function profileThreadFingerprint(threads: ReadonlyArray<OrchestrationV2ThreadShell>): string {
  const parts: string[] = [];
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const profileId = placementProfileOfTags(thread.tags);
    if (profileId === null) continue;
    const { instanceId, model } = thread.modelSelection;
    parts.push(`${thread.id}:${profileId}:${isLive(thread) ? "1" : "0"}:${instanceId}/${model}`);
  }
  return parts.join("|");
}

export interface PlacementWorkerOptions {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly nowMs?: (() => number) | undefined;
  /** How the Prism stream connects; false syncs over HTTP only. */
  readonly prismStream?: PrismSocketFactory | false | undefined;
  readonly streamReconnectDelay?: ((attempt: number) => Duration.Duration) | undefined;
}

export const makePlacementWorker = Effect.fn("PlacementWorker.make")(function* (
  options?: PlacementWorkerOptions,
) {
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
  const queuedMoves = new Map<ThreadId, QueuedMove>();
  const triggers = yield* Queue.unbounded<PlacementTrigger>();
  const lock = yield* Semaphore.make(1);
  let stream: { readonly client: PrismStream; readonly scope: Scope.Closeable } | null = null;
  let streamKey = "";
  let lastStreamErrorLogMs = 0;
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
              title: inPlace(move)
                ? `Compacted on ${shortAccountLabel(move.to)}`
                : `${shortAccountLabel(move.from)} → ${shortAccountLabel(move.to)}`,
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
    move: Move,
  ) {
    const parentId = thread.lineage.parentThreadId;
    if (inPlace(move)) return;
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

  const continueOn = Effect.fnUntraced(function* (thread: OrchestrationV2ThreadShell, move: Move) {
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

  // A live run moves through its thread's queue: `/compact` on the account it leaves, then the
  // continuation on the new one, both queued ahead of any message already waiting, and only then
  // the interrupt. The thread runs them the moment the interrupt ends the run, with nothing left
  // for placement to wait for. Returns true once queued, or why the move was not made.
  const startMove = Effect.fnUntraced(function* (
    thread: OrchestrationV2ThreadShell,
    move: Move,
    compactOnFrom: boolean,
  ) {
    if (inPlace(move) && !compactOnFrom) return "its account has no usage left to compact with";
    const queued = yield* projections.getThreadRecords(thread.id, ["runs", "messages"]).pipe(
      Effect.map(queuedRunsInDeliveryOrder),
      Effect.orElseSucceed(() => []),
    );
    const key = `${thread.id}:${move.runId}`;
    const compactMessageId = compactOnFrom
      ? MessageId.make(`${PLACEMENT_COMPACTION_MESSAGE_ID_PREFIX}${key}`)
      : null;
    const continueMessageId = MessageId.make(`placement-move:${key}`);
    const ahead = [
      ...(compactMessageId === null
        ? []
        : [{ messageId: compactMessageId, modelSelection: move.from, text: "/compact" }]),
      {
        messageId: continueMessageId,
        modelSelection: move.to,
        text: continuationText(move.from, move.to, move.reason),
      },
    ];
    for (const message of ahead) {
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(message.messageId),
        threadId: thread.id,
        ...message,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "server",
      });
    }
    queuedMoves.set(thread.id, { ...move, compactMessageId, continueMessageId });
    if (queued.length > 0) {
      const runs = (yield* projections.getThreadRecords(thread.id, ["runs"])).runs;
      for (const message of ahead) {
        const run = runs.find(
          (candidate) =>
            candidate.userMessageId === message.messageId && candidate.status === "queued",
        );
        if (run === undefined) continue;
        // Ahead of the first queued message that may be passed (completions may not be).
        for (const before of queued) {
          const placed = yield* threads
            .dispatch({
              type: "queued-run.reorder",
              commandId: CommandId.make(`placement-reorder:${message.messageId}:${before.id}`),
              threadId: thread.id,
              runId: run.id,
              beforeRunId: before.id,
            })
            .pipe(
              Effect.as(true),
              Effect.catchCause(() => Effect.succeed(false)),
            );
          if (placed) break;
        }
      }
    }
    // A run that ended on its own meanwhile cannot be interrupted; its queue starts anyway.
    yield* threads
      .dispatch({
        type: "run.interrupt",
        commandId: CommandId.make(`placement-interrupt:${thread.id}:${move.runId}`),
        threadId: thread.id,
        runId: move.runId,
        reason: inPlace(move)
          ? `Placement: compacting before the limit. ${move.reason}`
          : `Placement: moving to ${label(move.to)}. ${move.reason}`,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logInfo("placement.interrupt-skipped", { threadId: thread.id, cause }),
        ),
      );
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
    return true as const;
  });

  // Watches the moves the queue carries until their continuation starts. A run that fails on its
  // usage limit stops the queue behind it while that provider is limited (the `/compact` on the
  // spent account would fail the same way), so the continuation is taken out of the queue and
  // started on its own.
  const settleQueuedMoves = Effect.fnUntraced(function* (
    shellThreads: ReadonlyArray<OrchestrationV2ThreadShell>,
  ) {
    if (queuedMoves.size === 0) return;
    const byId = new Map(shellThreads.map((thread) => [thread.id, thread]));
    for (const [threadId, move] of queuedMoves) {
      const thread = byId.get(threadId);
      if (thread === undefined || thread.archivedAt !== null) {
        queuedMoves.delete(threadId);
        continue;
      }
      const records = yield* projections.getThreadRecords(threadId, ["runs"]).pipe(Effect.option);
      // A failed read says nothing about the queue; look again next sweep.
      if (Option.isNone(records)) continue;
      const runs = records.value.runs;
      const continuation = runs.find((run) => run.userMessageId === move.continueMessageId);
      if (continuation === undefined || continuation.status !== "queued") {
        // Started, or the owner took it out of the queue.
        queuedMoves.delete(threadId);
        continue;
      }
      // A provider out of usage stops the queue without marking it held.
      const stopped =
        continuation.queueHeld === true ||
        (thread.status === "failed" && thread.lastErrorClass === "usage_limit");
      if (isLive(thread) || !stopped) continue;
      queuedMoves.delete(threadId);
      for (const run of runs) {
        if (
          run.status !== "queued" ||
          (run.userMessageId !== move.continueMessageId &&
            run.userMessageId !== move.compactMessageId)
        ) {
          continue;
        }
        yield* threads
          .dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make(`placement-unqueue:${run.id}`),
            threadId,
            runId: run.id,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("placement.unqueue-failed", { threadId, cause }),
            ),
          );
      }
      if (thread.latestRunId !== null) handledFailures.add(`${threadId}:${thread.latestRunId}`);
      const key = `${threadId}:${move.runId}`;
      yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`placement-move-held:${key}`),
          messageId: MessageId.make(`placement-move-held:${key}`),
          threadId,
          modelSelection: move.to,
          text: continuationText(move.from, move.to, move.reason),
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("placement.held-continue-failed", { threadId, cause }),
          ),
        );
    }
  });

  // One stream per Prism source; a changed URL or token file connects again.
  const syncStream = Effect.fnUntraced(function* (source: PlacementSourceConfig | null) {
    const key =
      source !== null && source.enabled && options?.prismStream !== false
        ? `${source.url}\n${source.tokenFile}`
        : "";
    if (key === streamKey) return;
    yield* closeStream;
    streamKey = key;
    if (key === "" || source === null) return;
    const scope = yield* Scope.make();
    const offer = (trigger: PlacementTrigger) => Queue.offer(triggers, trigger).pipe(Effect.asVoid);
    const client = yield* openPrismStream({
      baseUrl: source.url,
      token: fs.readFileString(source.tokenFile).pipe(
        Effect.mapError(
          (cause) =>
            new PrismStreamError({
              message: `Reading the machine token failed: ${cause.message}`,
            }),
        ),
      ),
      onUpdate: (response) => offer({ kind: "pushed", response }),
      onOpen: offer({ kind: "connected" }),
      onError: (cause) => offer({ kind: "stream-error", cause }),
      socketFactory: typeof options?.prismStream === "function" ? options.prismStream : undefined,
      reconnectDelay: options?.streamReconnectDelay,
    }).pipe(Scope.provide(scope));
    stream = { client, scope };
  });

  const closeStream = Effect.suspend(() => {
    const current = stream;
    stream = null;
    streamKey = "";
    return current === null ? Effect.void : Scope.close(current.scope, Exit.void);
  });

  const sweepOnce = Effect.fn("PlacementWorker.sweep")(function* (trigger?: PlacementTrigger) {
    const nowMs = options?.nowMs ? options.nowMs() : DateTime.toEpochMillis(yield* DateTime.now);
    if (trigger?.kind === "stream-error") {
      if (nowMs - lastStreamErrorLogMs >= STREAM_ERROR_LOG_EVERY_MS) {
        lastStreamErrorLogMs = nowMs;
        yield* Effect.logWarning("placement.prism-stream-failed; syncing over HTTP meanwhile", {
          cause: trigger.cause,
        });
      }
      return;
    }
    const settings = yield* settingsService.getSettings;
    const source = settings.placementSource;
    const prismEnabled = source !== null && source.enabled;
    yield* syncStream(prismEnabled ? source : null);
    const shell = yield* projections.getShellSnapshot({ location: "active" });
    yield* settleQueuedMoves(shell.threads);

    // Prism pushed a changed answer: act on it now, without asking again.
    let pushed: PrismSyncResponse | null = null;
    if (trigger?.kind === "pushed") {
      if (!prismEnabled) return;
      pushed = yield* decodePrismStreamResponse(trigger.response).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("placement.prism-push-invalid", { cause }).pipe(Effect.as(null)),
        ),
      );
      if (pushed === null) return;
    }

    // Over the stream a report costs Prism next to nothing, so every change to the profile
    // threads and every acknowledgement goes out at once; over HTTP at most every 30 seconds.
    const streamOpen = stream?.client.isOpen() === true;
    const fingerprint = profileThreadFingerprint(shell.threads);
    const profileStateChanged = fingerprint !== lastProfileFingerprint;
    const dueByInterval = nowMs - lastSweepMs >= SWEEP_EVERY_MS;
    const dueByPrismEvent =
      prismEnabled &&
      (profileStateChanged || (streamOpen && pendingAcks.length > 0)) &&
      (streamOpen || nowMs - lastPrismAnswerMs >= SWEEP_EVERY_MS);
    const dueByConnect = prismEnabled && trigger?.kind === "connected";
    if (pushed === null && !dueByInterval && !dueByPrismEvent && !dueByConnect) return;
    if (pushed === null) {
      lastSweepMs = nowMs;
      lastProfileFingerprint = fingerprint;
    }

    if (!prismEnabled && Object.keys(settings.placementProfiles).length === 0) {
      queuedMoves.clear();
      return;
    }
    const providers = yield* registry.getProviders;
    book.sources = yield* usageSources.current;
    book.checkedAt = nowMs;

    let activeSettings = settings;
    let prismResponse: PrismSyncResponse | null = pushed;
    if (prismEnabled && pushed === null) {
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
      const overHttp = syncWithPrism({
        source,
        body,
        fs,
        fetchImpl: options?.fetchImpl,
      });
      const openStream = stream?.client;
      prismResponse = yield* (
        openStream !== undefined && openStream.isOpen()
          ? syncOverStream({ stream: openStream, body }).pipe(
              Effect.catchCause((cause) =>
                Effect.logInfo("placement.prism-stream-sync-failed; trying HTTP", {
                  cause,
                }).pipe(Effect.andThen(overHttp)),
              ),
            )
          : overHttp
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("placement.prism-sync-failed", { cause }).pipe(Effect.as(null)),
        ),
      );
      if (prismResponse !== null) pendingAcks.splice(0, acksToSend.length);
    }
    if (prismResponse !== null) {
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

    // When Prism answered, carry out its move instructions instead of local move decisions.
    if (prismResponse !== null) {
      const threadsById = new Map(shell.threads.map((thread) => [thread.id, thread]));
      for (const prismMove of prismResponse.moves ?? []) {
        if (handledPrismMoves.has(prismMove.id)) continue;
        const thread = threadsById.get(prismMove.threadId as ThreadId);
        if (thread === undefined || thread.archivedAt !== null || queuedMoves.has(thread.id)) {
          continue;
        }
        handledPrismMoves.add(prismMove.id);
        const at = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
        if (isLive(thread) && thread.activeRunId !== null) {
          const move: Move = {
            runId: thread.activeRunId,
            from: prismMove.from,
            to: prismMove.to,
            reason: prismMove.reason,
            at,
            prismMoveId: prismMove.id,
          };
          const started = yield* startMove(
            thread,
            move,
            !placementSelectionOutOfUsage(move.from, providers, book.sources, nowMs),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("placement.move-start-failed", { threadId: thread.id, cause }).pipe(
                Effect.as(false),
              ),
            ),
          );
          if (started !== true) {
            pendingAcks.push({
              id: prismMove.id,
              state: "failed",
              detail: started === false ? "the move could not be queued" : started,
            });
          }
        } else if (inPlace(prismMove)) {
          // Nothing runs to compact before the limit; the thread stays where it is.
          pendingAcks.push({ id: prismMove.id, state: "failed", detail: "the thread is idle" });
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
      if (profileId === null || thread.archivedAt !== null || queuedMoves.has(thread.id)) continue;
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
      const move: Move = {
        runId: thread.activeRunId,
        from: thread.modelSelection,
        to: target.to,
        reason: target.reason,
        at: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
      };
      yield* startMove(
        thread,
        move,
        !placementSelectionOutOfUsage(move.from, providers, book.sources, nowMs),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("placement.move-start-failed", { threadId: thread.id, cause }),
        ),
      );
    }
  });

  return {
    /** One sweep; a trigger is what woke it besides the scheduler. Sweeps never overlap. */
    sweep: (trigger?: PlacementTrigger) => lock.withPermits(1)(sweepOnce(trigger)),
    /** Wakes from the Prism stream: a pushed answer, a new connection, a failure. */
    triggers: triggers as Queue.Dequeue<PlacementTrigger>,
    close: closeStream,
  };
});

/** The sweep alone, for callers that drive it themselves. */
export const makePlacementSweep = (options?: PlacementWorkerOptions) =>
  makePlacementWorker(options).pipe(Effect.map((worker) => worker.sweep));

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const worker = yield* makePlacementWorker();
    yield* Effect.addFinalizer(() => worker.close);
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("placement", worker.sweep());
    // Prism's pushes are carried out the moment they arrive, not at the next tick.
    yield* forkParked(
      Queue.take(worker.triggers).pipe(
        Effect.flatMap((trigger) => worker.sweep(trigger)),
        Effect.catchCause((cause) =>
          Effect.logWarning("placement.triggered-sweep-failed", { cause }),
        ),
        Effect.forever,
      ),
    );
  }),
);
