import {
  ModelSelection,
  type OrchestrationV2ThreadShell,
  PLACEMENT_INSTANCE_ID,
  PlacementEntry,
  PlacementEntryDecision,
  PlacementPolicy,
  PlacementProfileId,
  type PlacementProfileDecision,
  type PlacementProfiles,
  type PlacementSourceConfig,
  type ServerProvider,
  type ServerProviderModel,
  type ServerSettings,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import {
  placementProfileOfTags,
  placementWindowReadings,
  selectionRunnable,
} from "@t3tools/shared/placement";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

export class PrismSyncError extends Schema.TaggedError<PrismSyncError>()("PrismSyncError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

const encodeJsonUnknown = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const SYNC_TIMEOUT_MS = 20_000;

const REASONING_OPTION_IDS = new Set(["effort", "reasoningEffort", "reasoning", "thought_level"]);

export interface PrismMoveAck {
  readonly id: string;
  readonly state: "continued" | "failed";
  readonly detail?: string | undefined;
}

export interface PrismSyncModel {
  readonly instanceId: string;
  readonly model: string;
  readonly label: string;
  readonly driver?: string;
  readonly provider?: string;
  readonly hidden?: boolean;
  readonly reasoning?:
    | {
        readonly optionId: string;
        readonly levels: ReadonlyArray<string>;
        readonly default: string;
      }
    | undefined;
  readonly blocked: string | null;
  readonly session?: { readonly usedPercent: number; readonly resetsAt?: string } | undefined;
  readonly weekly?: { readonly usedPercent: number; readonly resetsAt?: string } | undefined;
}

export interface PrismSyncThread {
  readonly threadId: string;
  readonly title: string;
  readonly profile: string;
  readonly selection: ModelSelection;
  readonly running: boolean;
}

export interface PrismSyncRequest {
  readonly v: 1;
  readonly environmentId: string;
  readonly models: ReadonlyArray<PrismSyncModel>;
  readonly threads: ReadonlyArray<PrismSyncThread>;
  readonly moves?: ReadonlyArray<PrismMoveAck> | undefined;
}

const PrismSyncProfileSchema = Schema.Struct({
  id: PlacementProfileId,
  label: Schema.String,
  entries: Schema.Array(PlacementEntry),
  next: Schema.NullOr(ModelSelection),
  ranked: Schema.Array(PlacementEntryDecision),
});

export const PrismSyncMoveSchema = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  from: ModelSelection,
  to: ModelSelection,
  reason: Schema.String,
});
export type PrismSyncMove = typeof PrismSyncMoveSchema.Type;

export const PrismSyncResponseSchema = Schema.Struct({
  v: Schema.Literal(1),
  checkedAt: Schema.String,
  policy: Schema.optional(PlacementPolicy),
  profiles: Schema.Array(PrismSyncProfileSchema),
  moves: Schema.optional(Schema.Array(PrismSyncMoveSchema)),
});
export type PrismSyncResponse = typeof PrismSyncResponseSchema.Type;

const decodePrismSyncResponse = Schema.decodeUnknownEffect(PrismSyncResponseSchema);

function extractReasoning(model: ServerProviderModel): PrismSyncModel["reasoning"] {
  const descriptors = model.capabilities?.optionDescriptors;
  if (!descriptors) return undefined;
  const desc = descriptors.find(
    (candidate) =>
      candidate.type === "select" &&
      (candidate.role === "reasoning" || REASONING_OPTION_IDS.has(candidate.id)),
  );
  if (!desc || desc.type !== "select" || desc.options.length === 0) return undefined;
  const levels = desc.options.map((option) => option.id);
  const defaultLevel =
    desc.options.find((option) => option.isDefault)?.id ?? desc.currentValue ?? levels[0]!;
  return { optionId: desc.id, levels, default: defaultLevel };
}

export function buildPrismSyncRequest(input: {
  readonly environmentId: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly sources: ReadonlyArray<UsageLimitSourceSnapshot>;
  readonly settings: ServerSettings;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly isLive: (thread: OrchestrationV2ThreadShell) => boolean;
  readonly moves: ReadonlyArray<PrismMoveAck>;
  readonly nowMs: number;
}): PrismSyncRequest {
  const models: PrismSyncModel[] = [];
  for (const provider of input.providers) {
    if (!provider.enabled || provider.instanceId === PLACEMENT_INSTANCE_ID) continue;
    const hidden = new Set(
      input.settings.providerModelPreferences?.[provider.instanceId]?.hiddenModels,
    );
    const displayName = provider.displayName;
    for (const model of provider.models) {
      const selection: ModelSelection = { instanceId: provider.instanceId, model: model.slug };
      const reasoning = extractReasoning(model);
      const blocked = selectionRunnable(selection, {
        providers: input.providers,
        settings: input.settings,
      });
      const readings = placementWindowReadings(
        selection,
        input.providers,
        input.sources,
        input.nowMs,
      );
      models.push({
        instanceId: provider.instanceId,
        model: model.slug,
        label: model.name,
        driver: provider.driver,
        ...(displayName ? { provider: displayName } : {}),
        ...(!model.isCustom && hidden.has(model.slug) ? { hidden: true } : {}),
        ...(reasoning === undefined ? {} : { reasoning }),
        blocked,
        ...(readings.session === undefined ? {} : { session: readings.session }),
        ...(readings.weekly === undefined ? {} : { weekly: readings.weekly }),
      });
    }
  }

  const threads: PrismSyncThread[] = [];
  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    const profile = placementProfileOfTags(thread.tags);
    if (profile === null) continue;
    threads.push({
      threadId: thread.id,
      title: thread.title,
      profile,
      selection: thread.modelSelection,
      running: input.isLive(thread),
    });
  }

  return {
    v: 1,
    environmentId: input.environmentId,
    models,
    threads,
    ...(input.moves.length > 0 ? { moves: input.moves } : {}),
  };
}

export function profilesFromPrismResponse(response: PrismSyncResponse): PlacementProfiles {
  const profiles: Record<string, { label: string; entries: ReadonlyArray<PlacementEntry> }> = {};
  for (const profile of response.profiles) {
    profiles[profile.id] = { label: profile.label, entries: profile.entries };
  }
  return profiles as PlacementProfiles;
}

export function decisionsFromPrismResponse(
  response: PrismSyncResponse,
): ReadonlyArray<PlacementProfileDecision> {
  return response.profiles.map((profile) => ({
    id: profile.id,
    label: profile.label,
    next: profile.next,
    ranked: profile.ranked,
  }));
}

export const syncWithPrism = Effect.fn("placement.syncWithPrism")(function* (input: {
  readonly source: PlacementSourceConfig;
  readonly body: PrismSyncRequest;
  readonly fs: FileSystem.FileSystem;
  readonly fetchImpl?: typeof fetch | undefined;
}) {
  const rawToken = yield* input.fs.readFileString(input.source.tokenFile);
  const token = rawToken.trim();
  const baseUrl = input.source.url.replace(/\/+$/, "");
  const fetchFn = input.fetchImpl ?? globalThis.fetch;
  const serialized = encodeJsonUnknown(input.body);
  const response = yield* Effect.tryPromise({
    try: () =>
      fetchFn(`${baseUrl}/v1/placement/sync`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token.length > 0 ? { authorization: `Bearer ${token}` } : {}),
        },
        body: serialized,
        // A Prism that does not answer must not hold up the placement sweep.
        signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
      }),
    catch: (cause) => new PrismSyncError({ message: "Prism sync request failed", cause }),
  });
  if (!response.ok) {
    return yield* new PrismSyncError({ message: `Prism sync returned HTTP ${response.status}` });
  }
  const json = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) => new PrismSyncError({ message: "Prism sync JSON parse failed", cause }),
  });
  return yield* decodePrismSyncResponse(json);
});
