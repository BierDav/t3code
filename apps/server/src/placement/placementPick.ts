import {
  CommandId,
  isPlacementPick,
  type ModelSelection,
  PLACEMENT_TAG_PREFIX,
  type ProjectId,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import {
  placementMoveTarget,
  placementPickSelection,
  placementTag,
  sameEntry,
} from "@t3tools/shared/placement";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import { decideProfile, PlacementBookRef } from "./PlacementBook.ts";

const readSettings = ServerSettingsService.ServerSettingsService.pipe(
  Effect.flatMap((service) => service.getSettings),
  Effect.orElseSucceed((): ServerSettings | null => null),
);

/**
 * The account a pick of the placement provider runs on, with the profile it joins. A thread
 * already on an account of that profile stays there while the account can run. Null when the
 * selection is not a placement pick or names no configured profile.
 */
export const resolvePlacementPick = Effect.fn("placement.resolvePick")(function* (input: {
  readonly selection: ModelSelection;
  readonly projectId: ProjectId | null;
  readonly current?: ModelSelection | undefined;
}) {
  if (!isPlacementPick(input.selection)) return null;
  const settings = yield* readSettings;
  const profileId = input.selection.model;
  const profile = settings?.placementProfiles[profileId];
  if (settings === null || profile === undefined) return null;
  const decision = decideProfile(yield* PlacementBookRef, {
    profileId,
    settings,
    providers: yield* ProviderRegistry.ProviderRegistry.pipe(
      Effect.flatMap((registry) => registry.getProviders),
    ),
    now: DateTime.toEpochMillis(yield* DateTime.now),
    projectId: input.projectId,
  });
  const current = input.current;
  const selection =
    current !== undefined && profile.entries.some((entry) => sameEntry(entry.selection, current))
      ? ((decision === null ? null : placementMoveTarget(decision, current))?.to ?? current)
      : placementPickSelection(decision, profile);
  return selection === null ? null : { profileId, selection };
});

/** Whether a selection keeps a thread in its profile: a pick, or one of the profile's accounts. */
export const staysInProfile = Effect.fn("placement.staysInProfile")(function* (
  profileId: string,
  selection: ModelSelection,
) {
  if (isPlacementPick(selection)) return true;
  const settings = yield* readSettings;
  const profile = settings?.placementProfiles[profileId];
  // A profile that is gone no longer schedules anything; leave its tag for the user to see.
  if (profile === undefined) return true;
  return profile.entries.some((entry) => sameEntry(entry.selection, selection));
});

/**
 * The tag commands that put a thread in `profileId` (null: in none), dropping any other
 * placement tag. Ids derive from the command that asked, so a retried command replays them.
 */
export function placementTagCommands(input: {
  readonly threadId: ThreadId;
  readonly tags: ReadonlyArray<string>;
  readonly profileId: string | null;
  readonly commandId: string;
}) {
  const wanted = input.profileId === null ? null : placementTag(input.profileId);
  const commands: Array<{
    readonly type: "thread.tag.set";
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly tag: string;
    readonly tagged: boolean;
  }> = [];
  for (const tag of input.tags) {
    if (!tag.startsWith(PLACEMENT_TAG_PREFIX) || tag === wanted) continue;
    commands.push({
      type: "thread.tag.set",
      commandId: CommandId.make(`${input.commandId}:placement-untag:${tag}`),
      threadId: input.threadId,
      tag,
      tagged: false,
    });
  }
  if (wanted !== null && !input.tags.includes(wanted)) {
    commands.push({
      type: "thread.tag.set",
      commandId: CommandId.make(`${input.commandId}:placement-tag`),
      threadId: input.threadId,
      tag: wanted,
      tagged: true,
    });
  }
  return commands;
}
