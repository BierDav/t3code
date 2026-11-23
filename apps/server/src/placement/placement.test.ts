import {
  DEFAULT_PLACEMENT_POLICY,
  DEFAULT_SERVER_SETTINGS,
  type OrchestrationV2ThreadShell,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  type ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "@effect/vitest";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import {
  decideProfile,
  makePlacementBook,
  PlacementBookRef,
  recordRemoteDecisions,
  recordSessionSample,
  REMOTE_DECISION_TTL_MS,
} from "./PlacementBook.ts";
import { launchProfileId } from "./placementLaunch.ts";
import { pickLeavesProfile, placementTagCommands } from "./placementPick.ts";
import {
  continuationText,
  makePlacementSweep,
  parentNoticeText,
  shortAccountLabel,
} from "./PlacementWorker.ts";
import {
  buildPrismSyncRequest,
  type PrismSyncRequest,
  type PrismSyncResponse,
} from "./prismSync.ts";

const claude = (model: string) => ({ instanceId: ProviderInstanceId.make("claudeAgent"), model });

const settings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  placementProfiles: {
    coding: { label: "Coding", entries: [{ selection: claude("claude-david/x"), enabled: true }] },
    review: { label: "Review", entries: [{ selection: claude("claude-1/x"), enabled: true }] },
  },
  placementPolicy: { ...DEFAULT_PLACEMENT_POLICY, roleProfiles: { review: "review" } },
};

describe("launchProfileId", () => {
  it("prefers the requested profile, then the role's, then the parent's", () => {
    expect(launchProfileId({ settings, requested: "coding", role: "review" })).toBe("coding");
    expect(launchProfileId({ settings, role: "review", parentProfile: "coding" })).toBe("review");
    expect(launchProfileId({ settings, role: "research", parentProfile: "coding" })).toBe("coding");
    expect(launchProfileId({ settings, role: "research" })).toBeNull();
  });

  it("lets an explicit model outside the profile opt out", () => {
    expect(
      launchProfileId({ settings, parentProfile: "coding", explicitModel: claude("other/x") }),
    ).toBeNull();
    expect(
      launchProfileId({
        settings,
        parentProfile: "coding",
        explicitModel: claude("claude-david/x"),
      }),
    ).toBe("coding");
  });

  it("ignores a profile that is not configured", () => {
    expect(launchProfileId({ settings, requested: "gone" })).toBeNull();
  });
});

describe("recordSessionSample", () => {
  const minute = 60_000;

  it("measures percent per running thread per hour", () => {
    const book = makePlacementBook();
    recordSessionSample(book, "k", { at: 0, used: 10, running: 2 });
    recordSessionSample(book, "k", { at: 15 * minute, used: 15, running: 2 });
    // 5% in 15 minutes with two threads: 10% per thread per hour.
    expect(recordSessionSample(book, "k", { at: 30 * minute, used: 20, running: 2 })).toBeCloseTo(
      10,
    );
  });

  it("starts over when the window resets", () => {
    const book = makePlacementBook();
    recordSessionSample(book, "k", { at: 0, used: 80, running: 1 });
    recordSessionSample(book, "k", { at: 20 * minute, used: 90, running: 1 });
    recordSessionSample(book, "k", { at: 25 * minute, used: 2, running: 1 });
    expect(book.samples.get("k")).toHaveLength(1);
  });

  it("learns nothing while no thread runs", () => {
    const book = makePlacementBook();
    recordSessionSample(book, "k", { at: 0, used: 10, running: 0 });
    expect(recordSessionSample(book, "k", { at: 30 * minute, used: 12, running: 0 })).toBe(
      undefined,
    );
  });
});

describe("move messages", () => {
  it("tell the moved thread and its parent what happened", () => {
    const from = claude("claude-david/x");
    const to = claude("claude-1/x");
    expect(continuationText(from, to, "A limit is at 96%.")).toContain(
      "moved from claude-david/x to claude-1/x: A limit is at 96%",
    );
    expect(parentNoticeText("thread-1" as never, from, to, "A limit is at 96%.")).toContain(
      "no action is needed",
    );
  });
});

describe("placementTagCommands", () => {
  const base = { threadId: "thread-1" as never, commandId: "cmd" };

  it("swaps the thread's placement tag and keeps its other tags", () => {
    const commands = placementTagCommands({
      ...base,
      tags: ["mine", "placement:coding"],
      profileId: "review",
    });
    expect(commands.map((command) => [command.tag, command.tagged])).toEqual([
      ["placement:coding", false],
      ["placement:review", true],
    ]);
  });

  it("does nothing when the thread already has the tag, and clears it for no profile", () => {
    expect(
      placementTagCommands({ ...base, tags: ["placement:coding"], profileId: "coding" }),
    ).toEqual([]);
    expect(
      placementTagCommands({ ...base, tags: ["placement:coding"], profileId: null }).map(
        (command) => command.tagged,
      ),
    ).toEqual([false]);
  });
});

describe("pickLeavesProfile", () => {
  const david = claude("claude-david/claude-opus-5-5");
  const one = claude("claude-1/claude-opus-5-5");

  it("takes a thread out of its profile on an explicit pick, even of its own account", () => {
    expect(pickLeavesProfile("thread.model-selection.set", david, david)).toBe(true);
    expect(pickLeavesProfile("thread.model-selection.set", one, david)).toBe(true);
    expect(pickLeavesProfile("message.dispatch", one, david)).toBe(true);
  });

  it("keeps the profile for a message on the thread's own account, whatever its options", () => {
    expect(
      pickLeavesProfile(
        "message.dispatch",
        { ...david, options: [{ id: "effort", value: "max" }] },
        david,
      ),
    ).toBe(false);
  });
});

describe("shortAccountLabel", () => {
  it("extracts the account prefix before slash or falls back to the model slug", () => {
    expect(shortAccountLabel(claude("claude-david/claude-opus-5-5"))).toBe("claude-david");
    expect(shortAccountLabel(claude("gpt-6-astra"))).toBe("gpt-6-astra");
  });
});

describe("Prism placement sync", () => {
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude",
    supportsTextGeneration: true,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-21T18:00:00.000Z",
    models: [
      {
        slug: "claude-david/claude-opus-5-5",
        name: "Opus 5.5 · claude-david",
        isCustom: false,
        supportsTextGeneration: true,
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              role: "reasoning",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High", isDefault: true },
              ],
            },
          ],
        },
      },
      {
        slug: "claude-1/claude-opus-5-5",
        name: "Opus 5.5 · claude-1",
        isCustom: false,
        supportsTextGeneration: true,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
  };

  it("reports picker visibility without removing models used for placement", () => {
    const [builtIn, custom] = provider.models;
    const request = buildPrismSyncRequest({
      environmentId: "test",
      providers: [{ ...provider, models: [builtIn!, { ...custom!, isCustom: true }] }],
      settings: {
        ...settings,
        providerModelPreferences: {
          [provider.instanceId]: {
            hiddenModels: [builtIn!.slug, custom!.slug],
            modelOrder: [],
          },
        },
      },
      threads: [],
      sources: [],
      isLive: () => false,
      moves: [],
      nowMs: 0,
    });
    expect(request.models).toHaveLength(2);
    expect(request.models[0]).toMatchObject({
      hidden: true,
      driver: "claudeAgent",
      provider: "Claude",
    });
    expect(request.models[1]).not.toHaveProperty("hidden");
  });

  it("uses Prism's remote decision while fresh and falls back to local ranking when stale", () => {
    const book = makePlacementBook();
    const localSettings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      placementProfiles: {
        coding: {
          label: "Coding",
          entries: [
            { selection: claude("claude-david/claude-opus-5-5"), enabled: true },
            { selection: claude("claude-1/claude-opus-5-5"), enabled: true },
          ],
        },
      },
    };
    const t0 = 1_000_000;
    recordRemoteDecisions(
      book,
      [
        {
          id: "coding",
          label: "Coding",
          next: claude("claude-1/claude-opus-5-5"),
          ranked: [
            {
              selection: claude("claude-1/claude-opus-5-5"),
              state: "promoted",
              reason: "Prism picked claude-1.",
              runningThreads: 0,
            },
          ],
        },
      ],
      t0,
    );

    const fresh = decideProfile(book, {
      profileId: "coding",
      settings: localSettings,
      providers: [provider],
      now: t0 + REMOTE_DECISION_TTL_MS - 1_000,
    });
    expect(fresh?.next).toEqual(claude("claude-1/claude-opus-5-5"));

    const stale = decideProfile(book, {
      profileId: "coding",
      settings: localSettings,
      providers: [provider],
      now: t0 + REMOTE_DECISION_TTL_MS + 1_000,
    });
    expect(stale?.next).toEqual(claude("claude-david/claude-opus-5-5"));
  });

  it.effect(
    "syncs profiles/policy into settings, applies each move once, and acks on the next sync",
    () => {
      const requests: Array<{ auth: string | null; body: PrismSyncRequest }> = [];
      const dispatched: Array<unknown> = [];
      const threadId = ThreadId.make("thr-1");
      const runId = RunId.make("run-1");

      let currentThread: OrchestrationV2ThreadShell = {
        id: threadId,
        projectId: "proj-1" as never,
        title: "Fix build",
        modelSelection: claude("claude-david/claude-opus-5-5"),
        runtimeMode: "full-access",
        interactionMode: "default",
        status: "running",
        activeRunId: runId,
        latestRunId: runId,
        latestRunCompletedAt: null,
        lastErrorClass: null,
        pendingRuntimeRequest: null,
        tags: ["placement:coding"],
        archivedAt: null,
        updatedAt: DateTime.makeUnsafe("2026-11-21T18:00:00.000Z"),
        lineage: { parentThreadId: null, relationshipToParent: null },
      } as unknown as OrchestrationV2ThreadShell;

      const prismResponse: PrismSyncResponse = {
        v: 1,
        checkedAt: "2026-11-21T18:20:00Z",
        policy: {
          switchAtPercent: 90,
          weeklySlackSessions: 2,
          roleProfiles: { review: "review" },
        },
        profiles: [
          {
            id: "coding",
            label: "Coding",
            entries: [
              { selection: claude("claude-david/claude-opus-5-5"), enabled: true },
              { selection: claude("claude-1/claude-opus-5-5"), enabled: true },
            ],
            next: claude("claude-1/claude-opus-5-5"),
            ranked: [
              {
                selection: claude("claude-1/claude-opus-5-5"),
                state: "ok",
                reason: "Session window at 10%.",
                runningThreads: 0,
              },
            ],
          },
        ],
        moves: [
          {
            id: "mac:thr-1:claude-1:1",
            threadId: "thr-1",
            from: claude("claude-david/claude-opus-5-5"),
            to: claude("claude-1/claude-opus-5-5"),
            reason: "The session limit is at 96%, at or past the 95% switch point.",
          },
        ],
      };

      const fakeFetch: typeof fetch = async (_url, init) => {
        const headers = new Headers(init?.headers);
        requests.push({
          auth: headers.get("authorization"),
          body: JSON.parse(String(init?.body)) as PrismSyncRequest,
        });
        return new Response(JSON.stringify(prismResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };

      const book = makePlacementBook();
      const layer = Layer.mergeAll(
        ServerSettingsService.layerTest({
          placementSource: {
            url: "https://prism.example.test",
            tokenFile: "/etc/prism/token",
            enabled: true,
          },
        }),
        Layer.succeed(ProviderRegistry.ProviderRegistry, {
          getProviders: Effect.succeed([provider]),
        } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
        Layer.succeed(UsageLimitSources.UsageLimitSources, {
          current: Effect.succeed([]),
        } as unknown as UsageLimitSources.UsageLimitSources["Service"]),
        Layer.succeed(ProjectionStore.ProjectionStoreV2, {
          getShellSnapshot: () => Effect.succeed({ threads: [currentThread] }),
          getThreadRecords: () => Effect.succeed({ runs: [], messages: [] }),
        } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
        Layer.succeed(ThreadManagement.ThreadManagementService, {
          dispatch: (cmd: { readonly type: string }) => {
            dispatched.push(cmd);
            if (cmd.type === "run.interrupt") {
              currentThread = {
                ...currentThread,
                status: "interrupted",
                activeRunId: null,
              };
            }
            return Effect.void;
          },
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Layer.succeed(Orchestrator.OrchestratorV2, {
          dispatch: () => Effect.void,
        } as unknown as Orchestrator.OrchestratorV2["Service"]),
        Layer.succeed(FileSystem.FileSystem, {
          readFileString: (path: string) =>
            path === "/etc/prism/token"
              ? Effect.succeed("  secret-machine-token\n")
              : Effect.die(`unexpected path ${path}`),
        } as unknown as FileSystem.FileSystem),
      );

      let fakeNow = 1_000_000;
      const program = Effect.gen(function* () {
        const sweep = yield* makePlacementSweep({
          fetchImpl: fakeFetch,
          nowMs: () => fakeNow,
        });
        const settingsSvc = yield* ServerSettingsService.ServerSettingsService;

        // Sweep 1: syncs with Prism, writes settings, interrupts the running thread.
        yield* sweep();
        const afterFirst = yield* settingsSvc.getSettings;
        expect(Object.keys(afterFirst.placementProfiles)).toEqual(["coding"]);
        expect(afterFirst.placementPolicy.switchAtPercent).toBe(90);
        expect(requests).toHaveLength(1);
        expect(requests[0]?.auth).toBe("Bearer secret-machine-token");
        expect(requests[0]?.body.models[0]?.reasoning).toEqual({
          optionId: "effort",
          levels: ["low", "high"],
          default: "high",
        });
        expect(requests[0]?.body.threads).toHaveLength(1);
        expect(dispatched.map((c) => (c as { type: string }).type)).toEqual(["run.interrupt"]);

        // Sweep 2: compact on the original account after the interrupt.
        fakeNow += 31_000;
        yield* sweep();
        expect(requests).toHaveLength(2);
        expect(dispatched[1]).toMatchObject({
          type: "message.dispatch",
          text: "/compact",
          modelSelection: prismResponse.moves?.[0]?.from,
        });

        // Sweep 3: the compaction is no longer running, so continue on the target.
        fakeNow += 31_000;
        yield* sweep();
        expect(requests).toHaveLength(3);
        expect(dispatched[2]).toMatchObject({
          type: "message.dispatch",
          modelSelection: prismResponse.moves?.[0]?.to,
        });

        // Sweep 4: acknowledge the completed move without applying it again.
        fakeNow += 31_000;
        yield* sweep();
        expect(requests).toHaveLength(4);
        expect(requests[3]?.body.moves).toEqual([
          { id: "mac:thr-1:claude-1:1", state: "continued" },
        ]);
        expect(dispatched).toHaveLength(3);
      }).pipe(Effect.provide(layer), Effect.provideService(PlacementBookRef, book));

      return program;
    },
  );

  it.effect.each([
    { name: "Prism asks for no move", withPrismMove: false },
    { name: "Prism also asks for the move", withPrismMove: true },
  ])("continues a run that hit its usage limit exactly once when $name", ({ withPrismMove }) => {
    const threadId = ThreadId.make("thr-limit");
    const runId = RunId.make("run-limit");
    const fakeNow = 1_000_000;
    const thread = {
      id: threadId,
      projectId: "proj-1" as never,
      title: "Fix build",
      modelSelection: claude("claude-david/claude-opus-5-5"),
      runtimeMode: "full-access",
      interactionMode: "default",
      status: "failed",
      activeRunId: null,
      latestRunId: runId,
      latestRunCompletedAt: DateTime.makeUnsafe(fakeNow - 60_000),
      lastErrorClass: "usage_limit",
      pendingRuntimeRequest: null,
      tags: ["placement:coding"],
      archivedAt: null,
      updatedAt: DateTime.makeUnsafe(fakeNow - 60_000),
      lineage: { parentThreadId: null, relationshipToParent: null },
    } as unknown as OrchestrationV2ThreadShell;
    // Prism's readings lag: it still ranks the account the run just failed on first.
    const response: PrismSyncResponse = {
      v: 1,
      checkedAt: "2026-11-21T18:20:00Z",
      profiles: [
        {
          id: "coding",
          label: "Coding",
          entries: [
            { selection: claude("claude-david/claude-opus-5-5"), enabled: true },
            { selection: claude("claude-1/claude-opus-5-5"), enabled: true },
          ],
          next: claude("claude-david/claude-opus-5-5"),
          ranked: [
            {
              selection: claude("claude-david/claude-opus-5-5"),
              state: "ok",
              reason: "Session window at 80%.",
              runningThreads: 0,
            },
            {
              selection: claude("claude-1/claude-opus-5-5"),
              state: "ok",
              reason: "Session window at 10%.",
              runningThreads: 0,
            },
          ],
        },
      ],
      moves: withPrismMove
        ? [
            {
              id: "mac:thr-limit:claude-1:1",
              threadId: "thr-limit",
              from: claude("claude-david/claude-opus-5-5"),
              to: claude("claude-1/claude-opus-5-5"),
              reason: "Out of usage.",
            },
          ]
        : [],
    };
    const dispatched: Array<{ readonly type: string }> = [];
    const layer = Layer.mergeAll(
      ServerSettingsService.layerTest({
        placementSource: { url: "https://prism.example.test", tokenFile: "/t", enabled: true },
      }),
      Layer.succeed(ProviderRegistry.ProviderRegistry, {
        getProviders: Effect.succeed([provider]),
      } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
      Layer.succeed(UsageLimitSources.UsageLimitSources, {
        current: Effect.succeed([]),
      } as unknown as UsageLimitSources.UsageLimitSources["Service"]),
      Layer.succeed(ProjectionStore.ProjectionStoreV2, {
        getShellSnapshot: () => Effect.succeed({ threads: [thread] }),
      } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
      Layer.succeed(ThreadManagement.ThreadManagementService, {
        dispatch: (cmd: { readonly type: string }) => {
          dispatched.push(cmd);
          return Effect.void;
        },
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      Layer.succeed(Orchestrator.OrchestratorV2, {
        dispatch: () => Effect.void,
      } as unknown as Orchestrator.OrchestratorV2["Service"]),
      Layer.succeed(FileSystem.FileSystem, {
        readFileString: () => Effect.succeed("token"),
      } as unknown as FileSystem.FileSystem),
    );
    return Effect.gen(function* () {
      const sweep = yield* makePlacementSweep({
        fetchImpl: async () =>
          new Response(JSON.stringify(response), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        nowMs: () => fakeNow,
      });
      yield* sweep();
      expect(dispatched.filter((c) => c.type === "message.dispatch")).toHaveLength(1);
    }).pipe(Effect.provide(layer), Effect.provideService(PlacementBookRef, makePlacementBook()));
  });

  /** One Prism sync against a thread whose run is live, with `queued` runs behind it. */
  const sweepOnce = (input: {
    readonly thread: OrchestrationV2ThreadShell;
    readonly move: NonNullable<PrismSyncResponse["moves"]>[number];
    readonly queued: ReadonlyArray<{ readonly id: string; readonly userMessageId: string }>;
  }) => {
    const dispatched: Array<Record<string, unknown> & { readonly type: string }> = [];
    let runs: Array<Record<string, unknown>> = input.queued.map((run, index) => ({
      ...run,
      status: "queued",
      ordinal: 10 + index,
      queuePosition: index + 1,
      requestedAt: DateTime.makeUnsafe("2026-11-21T18:00:00.000Z"),
    }));
    const response: PrismSyncResponse = {
      v: 1,
      checkedAt: "2026-11-21T18:20:00Z",
      profiles: [
        {
          id: "coding",
          label: "Coding",
          entries: [
            { selection: claude("claude-david/claude-opus-5-5"), enabled: true },
            { selection: claude("claude-1/claude-opus-5-5"), enabled: true },
          ],
          next: claude("claude-1/claude-opus-5-5"),
          ranked: [],
        },
      ],
      moves: [input.move],
    };
    const layer = Layer.mergeAll(
      ServerSettingsService.layerTest({
        placementSource: { url: "https://prism.example.test", tokenFile: "/t", enabled: true },
      }),
      Layer.succeed(ProviderRegistry.ProviderRegistry, {
        getProviders: Effect.succeed([provider]),
      } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
      Layer.succeed(UsageLimitSources.UsageLimitSources, {
        current: Effect.succeed([]),
      } as unknown as UsageLimitSources.UsageLimitSources["Service"]),
      Layer.succeed(ProjectionStore.ProjectionStoreV2, {
        getShellSnapshot: () => Effect.succeed({ threads: [input.thread] }),
        getThreadRecords: () => Effect.sync(() => ({ runs, messages: [] })),
      } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
      Layer.succeed(ThreadManagement.ThreadManagementService, {
        dispatch: (cmd: Record<string, unknown> & { readonly type: string }) =>
          Effect.sync(() => {
            dispatched.push(cmd);
            const mode = cmd.dispatchMode as { readonly type: string } | undefined;
            if (cmd.type === "message.dispatch" && mode?.type === "queue_after_active") {
              runs = [
                ...runs,
                {
                  id: `run-for-${String(cmd.messageId)}`,
                  userMessageId: cmd.messageId,
                  status: "queued",
                  ordinal: 10 + runs.length,
                  queuePosition: runs.length + 1,
                  requestedAt: DateTime.makeUnsafe("2026-11-21T18:30:00.000Z"),
                },
              ];
            }
          }),
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      Layer.succeed(Orchestrator.OrchestratorV2, {
        dispatch: () => Effect.void,
      } as unknown as Orchestrator.OrchestratorV2["Service"]),
      Layer.succeed(FileSystem.FileSystem, {
        readFileString: () => Effect.succeed("token"),
      } as unknown as FileSystem.FileSystem),
    );
    return Effect.gen(function* () {
      const sweep = yield* makePlacementSweep({
        fetchImpl: async () =>
          new Response(JSON.stringify(response), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        nowMs: () => 1_000_000,
      });
      yield* sweep();
      return dispatched;
    }).pipe(Effect.provide(layer), Effect.provideService(PlacementBookRef, makePlacementBook()));
  };

  const liveThread = (overrides: Record<string, unknown>) =>
    ({
      id: ThreadId.make("thr-q"),
      projectId: "proj-1" as never,
      title: "Long task",
      modelSelection: claude("claude-david/claude-opus-5-5"),
      runtimeMode: "full-access",
      interactionMode: "default",
      status: "running",
      activityRunStatus: "running",
      activeRunId: RunId.make("run-active"),
      latestRunId: RunId.make("run-active"),
      latestRunCompletedAt: null,
      lastErrorClass: null,
      pendingRuntimeRequest: null,
      tags: ["placement:coding"],
      archivedAt: null,
      updatedAt: DateTime.makeUnsafe("2026-11-21T18:00:00.000Z"),
      lineage: { parentThreadId: null, relationshipToParent: null },
      ...overrides,
    }) as unknown as OrchestrationV2ThreadShell;

  it.effect("moves a running thread with messages queued behind it ahead of the queue", () =>
    Effect.gen(function* () {
      // The queued follow-up is the shell's newest run, so its status is "queued"; the
      // active run is still working.
      const dispatched = yield* sweepOnce({
        thread: liveThread({ status: "queued", latestRunId: RunId.make("run-queued") }),
        move: {
          id: "mac:thr-q:claude-1:1",
          threadId: "thr-q",
          from: claude("claude-david/claude-opus-5-5"),
          to: claude("claude-1/claude-opus-5-5"),
          reason: "The session limit is at 96%, at or past the 95% switch point.",
        },
        queued: [{ id: "run-queued", userMessageId: "msg-user" }],
      });
      expect(dispatched.map((cmd) => cmd.type)).toEqual([
        "message.dispatch",
        "message.dispatch",
        "queued-run.reorder",
        "queued-run.reorder",
        "run.interrupt",
      ]);
      expect(dispatched[0]).toMatchObject({
        text: "/compact",
        modelSelection: claude("claude-david/claude-opus-5-5"),
        dispatchMode: { type: "queue_after_active" },
      });
      expect(dispatched[1]).toMatchObject({
        modelSelection: claude("claude-1/claude-opus-5-5"),
        dispatchMode: { type: "queue_after_active" },
      });
      // Both go ahead of the queued message, the compaction first.
      expect(dispatched[2]).toMatchObject({
        runId: "run-for-placement-compact:thr-q:run-active",
        beforeRunId: "run-queued",
      });
      expect(dispatched[3]).toMatchObject({
        runId: "run-for-placement-move:thr-q:run-active",
        beforeRunId: "run-queued",
      });
      expect(dispatched[4]).toMatchObject({ runId: "run-active" });
    }),
  );

  it.effect(
    "compacts in place, without a parent notice, when Prism moves a thread onto its own account",
    () =>
      Effect.gen(function* () {
        const dispatched = yield* sweepOnce({
          thread: liveThread({}),
          move: {
            id: "mac:thr-q:claude-david:1",
            threadId: "thr-q",
            from: claude("claude-david/claude-opus-5-5"),
            to: claude("claude-david/claude-opus-5-5"),
            reason: "Compacting before the limit, to hand over a short context when it is reached.",
          },
          queued: [],
        });
        expect(dispatched.map((cmd) => cmd.type)).toEqual(["run.interrupt"]);
        expect(String(dispatched[0]?.reason)).toContain("compacting before the limit");
      }),
  );

  it("words an in-place continuation as a compaction", () => {
    const david = claude("claude-david/claude-opus-5-5");
    expect(continuationText(david, david, "Close to the limit.")).toContain(
      "Placement compacted this thread on claude-david/claude-opus-5-5: Close to the limit",
    );
  });
});
