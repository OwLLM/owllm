// Typed wrappers around the code-signing vault Tauri commands (signing.rs).
// One thin domain module next to SigningPage, mirroring github.ts / remoteDevices.ts.

import { invoke } from "@tauri-apps/api/core";

export type AppleStatus = {
  hasCertificate: boolean;
  hasCertificatePassword: boolean;
  hasAppPassword: boolean;
  signingIdentity: string;
  appleId: string;
  teamId: string;
  certSubject: string;
  certNotAfterMs: number;
  daysLeft: number | null;
  ready: boolean;
  updatedMs: number;
};

export type WindowsStatus = {
  hasCertificate: boolean;
  hasCertificatePassword: boolean;
  thumbprint: string;
  subject: string;
  tsa: string;
  ready: boolean;
  updatedMs: number;
};

export type SigningStatus = {
  apple: AppleStatus | null;
  windows: WindowsStatus | null;
};

export type AppleSaveInput = {
  signingIdentity: string;
  appleId: string;
  teamId: string;
  /** Empty = keep the stored value. */
  appSpecificPassword: string;
  /** Empty = keep the stored value. */
  certificateP12B64: string;
  /** Empty = keep the stored value. */
  certificatePassword: string;
};

export async function signingStatus(): Promise<SigningStatus> {
  return invoke<SigningStatus>("signing_status");
}

export async function signingAppleSave(input: AppleSaveInput): Promise<SigningStatus> {
  return invoke<SigningStatus>("signing_apple_save", { input });
}

/** Import a .p12 by absolute path; the app base64-encodes it and (best-effort)
 *  parses the identity + expiry via openssl. */
export async function signingAppleImportP12(path: string, password: string): Promise<SigningStatus> {
  return invoke<SigningStatus>("signing_apple_import_p12", { path, password });
}

export async function signingWindowsSave(
  thumbprint: string,
  subject: string,
  tsa: string,
  certificatePfxB64: string,
  certificatePassword: string,
): Promise<SigningStatus> {
  return invoke<SigningStatus>("signing_windows_save", {
    thumbprint, subject, tsa, certificatePfxB64, certificatePassword,
  });
}

export async function signingClear(platform: "apple" | "windows" | "all"): Promise<SigningStatus> {
  return invoke<SigningStatus>("signing_clear", { platform });
}

/** Reveal the CI env values (secrets). Used by Copy-values + Push-to-GitHub. */
export async function signingExportEnv(platform: "apple" | "windows"): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("signing_export_env", { platform });
}

/** Push stored secrets to a repo's GitHub Actions secrets via the `gh` CLI. */
export async function signingPushGithub(
  owner: string, repo: string, platform: "apple" | "windows",
): Promise<string> {
  return invoke<string>("signing_push_github", { owner, repo, platform });
}
