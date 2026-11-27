import { msg } from "gt-react";
import { m } from "../i18n/messages";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { toastManager } from "./ui/toast";

export function startPrismConnectionToast(): () => void {
  let shown: { readonly id: string; readonly description: string } | null = null;
  const unsubscribe = appAtomRegistry.subscribe(
    environmentServerConfigsAtom,
    (configs) => {
      const offline: string[] = [];
      const http: string[] = [];
      for (const { prismConnection, environment } of configs.values()) {
        if (prismConnection === "offline") offline.push(environment.label);
        if (prismConnection === "http") http.push(environment.label);
      }
      if (offline.length === 0 && http.length === 0) {
        if (shown) toastManager.close(shown.id);
        shown = null;
        return;
      }
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
          ? [
              m(
                msg("{hosts}: T3 Code is syncing with Prism over HTTP.", {
                  hosts: http.join(", "),
                }),
              ),
            ]
          : []),
      ].join(" ");
      if (shown?.description === description) return;
      if (shown) toastManager.close(shown.id);
      shown = {
        id: toastManager.add({
          type: "warning",
          title: m(msg("Prism connection lost")),
          description,
          timeout: 0,
        }),
        description,
      };
    },
    { immediate: true },
  );
  return () => {
    unsubscribe();
    if (shown) toastManager.close(shown.id);
  };
}
