import { requireOptionalNativeModule } from "expo";
import { AppState, Platform } from "react-native";
import { pairEnvironment } from "../../state/use-remote-environment-registry";

interface PrismPairingModule {
  getPrismPairingUrls(): Promise<readonly string[]>;
  markPrismPairingComplete(url: string): Promise<void>;
}

export function installPrismPairing(): () => void {
  if (Platform.OS !== "android") return () => {};
  const native = requireOptionalNativeModule<PrismPairingModule>("T3NativeControls");
  if (!native?.getPrismPairingUrls) return () => {};
  let running = false;
  let disposed = false;
  const run = async () => {
    if (running || disposed) return;
    running = true;
    try {
      const urls = await native.getPrismPairingUrls();
      for (const url of urls) {
        if (disposed) return;
        try {
          const target = new URL(url);
          if (target.protocol !== "https:" || target.username || target.password) continue;
          const { ok } = await pairEnvironment(url);
          if (ok) await native.markPrismPairingComplete(url);
        } catch {
          // Android may deliver the configuration before the phone's VPN is ready.
        }
      }
    } catch {
      // The native module can be detached when React Native reloads.
    } finally {
      running = false;
    }
  };
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") void run();
  });
  void run();
  return () => {
    disposed = true;
    subscription.remove();
  };
}
