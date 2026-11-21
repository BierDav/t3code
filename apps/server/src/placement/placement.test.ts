import {
  DEFAULT_PLACEMENT_POLICY,
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makePlacementBook, recordSessionSample } from "./PlacementBook.ts";
import { launchProfileId } from "./placementLaunch.ts";
import { placementTagCommands } from "./placementPick.ts";
import { continuationText, parentNoticeText } from "./PlacementWorker.ts";

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
