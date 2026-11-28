import { describe, expect, it, vi } from "vite-plus/test";

import { prismConnectionBannerItem } from "./ComposerUsageLimits";

function item(
  status: Parameters<typeof prismConnectionBannerItem>[0]["status"],
  environmentLabel: string | null = null,
) {
  return prismConnectionBannerItem({ status, environmentLabel, onDismiss: vi.fn() });
}

describe("prismConnectionBannerItem", () => {
  it("shows nothing while Prism is connected or not configured", () => {
    expect(item("connected")).toBeNull();
    expect(item(undefined)).toBeNull();
  });

  it("warns that placement runs on saved data while Prism is unreachable", () => {
    const offline = item("offline");
    expect(offline).toMatchObject({
      variant: "warning",
      group: "environment",
      title: "Prism is unreachable",
      description: "T3 Code is using saved profiles and local usage data.",
    });
    expect(offline?.onDismiss).toBeUndefined();
  });

  it("gives a dismissible notice while Prism syncs over HTTP", () => {
    expect(item("http")).toMatchObject({
      variant: "info",
      group: "environment",
      title: "Syncing with Prism over HTTP",
      dismissLabel: "Dismiss Prism notice",
    });
  });

  it("names the machine when there is more than one", () => {
    expect(item("offline", "Build box")?.title).toBe("Build box can't reach Prism");
    expect(item("http", "Build box")?.title).toBe("Build box is syncing with Prism over HTTP");
  });
});
