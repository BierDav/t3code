import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isPlacementPick,
  type ModelSelection,
  type ScopedThreadRef,
  type ServerSettings,
} from "@t3tools/contracts";
import { sameEntry } from "@t3tools/shared/placement";
import { useEffect } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";

/**
 * A placement profile pick never equals the thread's model: the server runs the thread on one
 * of the profile's accounts instead. Once it does, the pick has taken effect, so the composer
 * drops it and shows the account, rather than a model switch that never lands.
 */
export function usePlacementPickRelease(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly threadStarted: boolean;
  readonly threadModelSelection: ModelSelection | null | undefined;
  readonly placementProfiles: ServerSettings["placementProfiles"] | undefined;
}) {
  const { threadRef, threadStarted, threadModelSelection, placementProfiles } = input;
  const pick = useComposerDraftStore((store) => {
    if (threadRef === null) return null;
    const draft = store.draftsByThreadKey[scopedThreadKey(threadRef)];
    if (!draft?.modelSelectionExplicit || !draft.activeProvider) return null;
    const selection = draft.modelSelectionByProvider[draft.activeProvider];
    return selection !== undefined && isPlacementPick(selection) ? selection : null;
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the persisted composer draft in step with the server, which moves the thread onto one of the profile's accounts
  useEffect(() => {
    if (threadRef === null || pick === null || !threadStarted || !threadModelSelection) return;
    const profile = placementProfiles?.[pick.model];
    if (!profile?.entries.some((entry) => sameEntry(entry.selection, threadModelSelection))) {
      return;
    }
    useComposerDraftStore.getState().releaseModelSelection(threadRef, pick);
  }, [threadRef, pick, threadStarted, threadModelSelection, placementProfiles]);
}
