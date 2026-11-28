import type { ServerConfig } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const serverConfigs = vi.hoisted(() => ({ size: 1 }));

vi.mock("react-native", () => ({
  Pressable: ({
    children,
    accessibilityLabel,
    onPress,
  }: {
    children: ReactNode;
    accessibilityLabel?: string;
    onPress: () => void;
  }) => (
    <button type="button" aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../state/entities", () => ({ useServerConfigs: () => serverConfigs }));

import { PrismConnectionCard } from "./PrismConnectionCard";

function config(prismConnection?: ServerConfig["prismConnection"]): ServerConfig {
  return {
    environment: { environmentId: "env-1", label: "Build box" },
    ...(prismConnection === undefined ? {} : { prismConnection }),
  } as unknown as ServerConfig;
}

function renderCard(serverConfig: ServerConfig | null) {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<PrismConnectionCard serverConfig={serverConfig} />));
  return {
    container,
    rerender: (next: ServerConfig | null) =>
      act(() => root.render(<PrismConnectionCard serverConfig={next} />)),
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

describe("PrismConnectionCard", () => {
  it("warns while Prism is unreachable and hides once it recovers", () => {
    using card = renderCard(config("offline"));
    expect(card.container.textContent).toBe(
      "Prism is unreachableT3 Code is using saved profiles and local usage data.",
    );
    expect(card.container.querySelector("button")).toBeNull();
    card.rerender(config("connected"));
    expect(card.container.textContent).toBe("");
  });

  it("shows nothing without a config or a Prism link", () => {
    using none = renderCard(null);
    expect(none.container.textContent).toBe("");
    using unset = renderCard(config());
    expect(unset.container.textContent).toBe("");
  });

  it("lets the HTTP notice be dismissed", () => {
    using card = renderCard(config("http"));
    expect(card.container.textContent).toContain("Syncing with Prism over HTTP");
    const dismiss = card.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss Prism notice"]',
    );
    act(() => dismiss?.click());
    expect(card.container.textContent).toBe("");
  });

  it("names the machine when there is more than one", () => {
    serverConfigs.size = 2;
    using _reset = { [Symbol.dispose]: () => void (serverConfigs.size = 1) };
    using card = renderCard(config("offline"));
    expect(card.container.textContent).toContain("Build box can't reach Prism");
  });
});
