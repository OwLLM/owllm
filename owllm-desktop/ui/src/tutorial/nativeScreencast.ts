// Bridge to GNOME Shell's own recorder (src-tauri/src/screencast.rs).
//
// getDisplayMedia() cannot record on GNOME: WebKitGTK asks
// xdg-desktop-portal-gnome, that backend SEGVs on WebKit's parent-window
// handle, and the capture request dies with OverconstrainedError ~25 s later.
// Where this bridge reports support, the recorder uses it INSTEAD of
// getDisplayMedia rather than waiting for that failure. Everywhere else
// (macOS, Windows, non-GNOME Linux) `supported` is false and nothing changes.

import { invoke } from "@tauri-apps/api/core";

export type NativeScreencastFile = { path: string; bytes: number };

export async function nativeScreencastSupported(): Promise<boolean> {
  try {
    return await invoke<boolean>("screencast_supported");
  } catch {
    return false;
  }
}

/** Returns the file GNOME is writing to. There is no source picker. */
export async function nativeScreencastStart(
  fileStem: string,
  fps: number,
  appWindowOnly: boolean,
): Promise<string> {
  return await invoke<string>("screencast_start", { fileStem, fps, appWindowOnly });
}

export async function nativeScreencastStop(): Promise<NativeScreencastFile> {
  return await invoke<NativeScreencastFile>("screencast_stop");
}
