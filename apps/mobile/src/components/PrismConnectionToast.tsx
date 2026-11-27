import { msg, useMessages } from "gt-react-native";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useServerConfigs } from "../state/entities";
import { Toast } from "./ui/Toast";

export function PrismConnectionToast() {
  const configs = useServerConfigs();
  const m = useMessages();
  const { bottom } = useSafeAreaInsets();
  const offline: string[] = [];
  const http: string[] = [];
  for (const { prismConnection, environment } of configs.values()) {
    if (prismConnection === "offline") offline.push(environment.label);
    if (prismConnection === "http") http.push(environment.label);
  }
  if (offline.length === 0 && http.length === 0) return null;
  const description = [
    ...(offline.length > 0
      ? [
          m(
            msg("{hosts}: T3 Code will use saved profiles and local usage data.", {
              hosts: offline.join(", "),
            }),
          ),
        ]
      : []),
    ...(http.length > 0
      ? [m(msg("{hosts}: T3 Code is syncing with Prism over HTTP.", { hosts: http.join(", ") }))]
      : []),
  ].join(" ");
  return (
    <View pointerEvents="none" className="absolute inset-x-4" style={{ bottom: bottom + 12 }}>
      <Toast tone="danger" message={m(msg("Prism connection lost"))} description={description} />
    </View>
  );
}
