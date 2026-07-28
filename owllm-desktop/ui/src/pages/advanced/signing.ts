// Typed wrappers around the code-signing vault Tauri commands (signing.rs).
// One thin domain module next to SigningPage, mirroring github.ts / remoteDevices.ts.

import { invoke } from "@tauri-apps/api/core";

export type AppleStatus = {
  hasCertificate: boolean;
  hasCertificatePassword: boolean;
  hasAppPassword: boolean;
  /** A key from "Generate signing request" is stored — a bare Apple .cer can be imported. */
  hasPrivateKey: boolean;
  signingIdentity: string;
  appleId: string;
  teamId: string;
  certSubject: string;
  certNotAfterMs: number;
  daysLeft: number | null;
  ready: boolean;
  /** Not stored here, but another PC on the account holds the certificate
   *  (secret material never syncs) — sign there. */
  certOnOtherDevice: boolean;
  updatedMs: number;
};

export type WindowsStatus = {
  hasCertificate: boolean;
  hasCertificatePassword: boolean;
  thumbprint: string;
  subject: string;
  tsa: string;
  ready: boolean;
  /** See {@link AppleStatus.certOnOtherDevice}. */
  certOnOtherDevice: boolean;
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

export type CsrResult = {
  /** Absolute path of the written .certSigningRequest (upload this at Apple's portal). */
  csrPath: string;
  csrPem: string;
};

/** No-Mac path, step 1: generate a private key (stored encrypted) + a CSR file
 *  to upload at Apple's "Create a certificate" page. */
export async function signingAppleGenCsr(commonName: string, email: string): Promise<CsrResult> {
  return invoke<CsrResult>("signing_apple_gen_csr", { commonName, email });
}

/** No-Mac path, step 2: import the bare .cer/.cert/.crt/.pem Apple issues —
 *  paired with the generated key into the .p12 the pipeline needs. */
export async function signingAppleImportCert(path: string): Promise<SigningStatus> {
  return invoke<SigningStatus>("signing_apple_import_cert", { path });
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

// ---------------------------------------------------------------------------
// Credential hub — live environment probes + provider portals opened in the
// app-styled agent browser (already logged in via profile + vault autofill).
// ---------------------------------------------------------------------------

export type HubStatus = {
  /** Stored Authenticode thumbprint is mounted in the OS store right now
   *  (null = no thumbprint stored, or no store probe on this OS). */
  certInStore: boolean | null;
  certStoreDetail: string;
  /** SimplySign Desktop running (null off Windows). */
  simplysignRunning: boolean | null;
  opensslOk: boolean;
  ghInstalled: boolean;
  ghAccount: string;
  webLoginCount: number;
};

export async function signingHubStatus(): Promise<HubStatus> {
  return invoke<HubStatus>("signing_hub_status");
}

/** Open a provider portal in the OwLLM browser; `url` overrides the catalog. */
export async function signingPortalOpen(provider: string, url?: string): Promise<string> {
  return invoke<string>("signing_portal_open", { provider, url: url ?? null });
}
