import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { pushOut } from "./notifyOut";

let permission: Promise<boolean> | null = null;

function allowed(): Promise<boolean> {
  if (!permission) {
    permission = (async () =>
      (await isPermissionGranted()) ||
      (await requestPermission()) === "granted")().finally(() => {
      permission = null;
    });
  }
  return permission;
}

/** Callers retain foreground, preference, toast and cooldown decisions. */
export async function notify({
  title,
  body,
  event,
  forwardTitle = title,
  checkPermission = true,
}: {
  title: string;
  body: string;
  event?: string;
  forwardTitle?: string;
  checkPermission?: boolean;
}): Promise<void> {
  if (!checkPermission || (await allowed())) sendNotification({ title, body });
  // Preserve forwarding after denial and its suppression after a native failure.
  if (event) pushOut(forwardTitle, body, event);
}
