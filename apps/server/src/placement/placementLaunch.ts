import type { ProjectId, ServerProvider, ServerSettings } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { decideProfile, PlacementBookRef } from "./PlacementBook.ts";

/**
 * The profile a new thread joins: the one asked for, else the delegated role's, else the
 * parent's. A pinned model joins none, and so does `requested: ""`.
 */
export function launchProfileId(input: {
  readonly settings: ServerSettings;
  readonly requested?: string | undefined;
  readonly role?: string | undefined;
  readonly parentProfile?: string | null;
  readonly pinned: boolean;
}): string | null {
  if (input.pinned || input.requested === "") return null;
  const profileId =
    input.requested ??
    (input.role === undefined
      ? undefined
      : input.settings.placementPolicy.roleProfiles[input.role]) ??
    input.parentProfile ??
    null;
  if (profileId === null) return null;
  return input.settings.placementProfiles[profileId] === undefined ? null : profileId;
}

/** The account a new thread in the profile starts on now, with the entry's options. */
export const launchSelection = Effect.fn("placement.launchSelection")(function* (input: {
  readonly profileId: string;
  readonly settings: ServerSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly projectId?: ProjectId | null;
}) {
  const book = yield* PlacementBookRef;
  const decision = decideProfile(book, {
    profileId: input.profileId,
    settings: input.settings,
    providers: input.providers,
    now: DateTime.toEpochMillis(yield* DateTime.now),
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
  });
  return decision?.next ?? null;
});

/** What `orchestrator_capabilities` reports about placement. */
export const placementCapabilities = Effect.fn("placement.capabilities")(function* (
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider>,
  projectId: ProjectId | undefined,
  profile: string | null,
) {
  const book = yield* PlacementBookRef;
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  return {
    profile,
    profiles: Object.keys(settings.placementProfiles).flatMap((profileId) => {
      const decision = decideProfile(book, {
        profileId,
        settings,
        providers,
        now,
        ...(projectId === undefined ? {} : { projectId }),
      });
      if (decision === null) return [];
      return [
        {
          id: profileId,
          label: decision.label,
          next:
            decision.next === null ? null : `${decision.next.instanceId}/${decision.next.model}`,
          entries: decision.ranked.map(
            (entry) => `${entry.selection.instanceId}/${entry.selection.model}: ${entry.state}`,
          ),
        },
      ];
    }),
  };
});
