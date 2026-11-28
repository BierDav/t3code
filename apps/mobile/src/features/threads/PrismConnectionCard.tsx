import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { msg, useMessages } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { useServerConfigs } from "../../state/entities";

/**
 * Shown above the composer while its machine has no live Prism stream. Offline, placement falls
 * back to saved profiles and local usage readings; over HTTP it still syncs, only less promptly.
 */
export function PrismConnectionCard({ serverConfig }: { serverConfig: ServerConfig | null }) {
  const m = useMessages();
  const multipleEnvironments = useServerConfigs().size > 1;
  const [dismissedHttpEnvironmentId, setDismissedHttpEnvironmentId] =
    useState<EnvironmentId | null>(null);
  const status = serverConfig?.prismConnection;
  if (!serverConfig || (status !== "offline" && status !== "http")) return null;
  const { environmentId, label } = serverConfig.environment;
  if (status === "http" && dismissedHttpEnvironmentId === environmentId) return null;
  const offline = status === "offline";
  const title = offline
    ? multipleEnvironments
      ? m(msg("{environment} can't reach Prism", { environment: label }))
      : m(msg("Prism is unreachable"))
    : multipleEnvironments
      ? m(msg("{environment} is syncing with Prism over HTTP", { environment: label }))
      : m(msg("Syncing with Prism over HTTP"));
  const description = offline
    ? m(msg("T3 Code is using saved profiles and local usage data."))
    : m(msg("Profiles and usage still sync while the live connection is down."));
  return (
    <View
      accessibilityRole={offline ? "alert" : undefined}
      className={
        offline
          ? "mx-3 mb-2 flex-row gap-2 rounded-xl border border-warning-foreground/25 bg-screen p-3"
          : "mx-3 mb-2 flex-row gap-2 rounded-xl border border-border bg-screen p-3"
      }
    >
      <View className="pt-0.5">
        <SymbolView
          name={offline ? "exclamationmark.triangle" : "cloud"}
          size={16}
          tintColorClassName={offline ? "accent-warning-foreground" : "accent-icon-muted"}
        />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-sm font-t3-medium text-foreground">{title}</Text>
        <Text className="text-sm text-foreground-muted">{description}</Text>
      </View>
      {offline ? null : (
        <Pressable
          accessibilityLabel={m(msg("Dismiss Prism notice"))}
          accessibilityRole="button"
          hitSlop={12}
          onPress={() => setDismissedHttpEnvironmentId(environmentId)}
          className="-me-1 self-start p-1 active:opacity-60"
        >
          <SymbolView
            name="xmark"
            size={14}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
        </Pressable>
      )}
    </View>
  );
}
