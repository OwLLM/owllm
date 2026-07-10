# OwLLM Remote Devices / Fleet Control

Secure remote control of one OwLLM Desktop install from another. This is **not
"SSH into WSL"** — it is a device-to-device control plane where the *permission
to control a machine is a cryptographic key the target has explicitly trusted*,
not a GitHub login. GitHub account matching helps **discovery**; a paired,
signed device key is what grants **control**. WSL is just one execution
environment *inside* a Windows target.

Status: **v1 slice shipped** (see "What ships in v1" below). Module lives at
`src-tauri/src/remote_devices/` (Rust) and `ui/src/pages/advanced/DevicesPage.tsx`
(UI). The name `fleet` was already taken by git-worktree agent isolation
(`fleet.rs`), so this module is `remote_devices`.

---

## Threat model & non-negotiables

1. **GitHub auth ≠ control.** A matching GitHub account only lets two installs
   *see* each other in the registry. Controlling a machine requires the target
   to have **cryptographically paired** with the controller's device key. An
   attacker who steals a GitHub token still cannot run a single command.
2. **The relay is untrusted.** Every command body is **end-to-end sealed**
   (X25519 ECDH → AES-256-GCM) to the target's key and **signed** (Ed25519) by
   the controller. A relay only ever forwards ciphertext. It cannot read,
   forge, or replay a command.
3. **Fail closed.** Missing/corrupt config, unknown device, revoked device,
   stale timestamp, replayed nonce, or a policy that doesn't explicitly allow
   the action → the command is **refused**. The default policy is read-only
   diagnostics; nothing else runs until a human flips a toggle on the target.
4. **Private keys never leave the machine.** The Ed25519 signing key and X25519
   secret are stored locally, DPAPI-protected on Windows (passthrough on other
   OSes, matching `crypt.rs`). They are **never** written to the vault / GitHub /
   any sync channel. Only public keys and metadata sync.
5. **Everything is audited, redacted, on both ends.** One append-only JSONL line
   per request on the controller *and* the target. Secrets and command payloads
   are redacted by field-name (the same default-redact discipline as `kvm.rs`).

---

## Module layout (mirrors the required separation of concerns)

```
src-tauri/src/remote_devices/
  mod.rs         Tauri commands + orchestration + control-session state + self-test
  protocol.rs    Wire types: DeviceRecord, CommandKind, CommandRequest/Result,
                 SignedEnvelope, PermissionPolicy, Authorization
  identity.rs    Persistent device keypair (Ed25519 + X25519), device id, name
  registry.rs    "My OwLLM Devices" — known-device metadata store
  trust.rs       Trusted-controller store + pairing request/approve/deny/revoke
  policy.rs      authorize(kind, policy) — the pure security decision (+ tests)
  crypto.rs      sign / verify / seal / open — Ed25519 + X25519 + AES-256-GCM (+ tests)
  executor.rs    Diagnostics / shell / WSL execution with timeout + cancellation
  transport.rs   Transport trait + LoopbackTransport (in-process, for v1 + tests)
  audit.rs       Redacted append-only JSONL, both sides (+ redaction tests)
```

Files on disk (all under `paths::user_data_root()`, none synced):

| File | Contents |
|---|---|
| `remote_device_identity.json` | This device's id, name, DPAPI-wrapped Ed25519 + X25519 secrets, public keys |
| `remote_devices_registry.json` | Known peer devices (public metadata) |
| `remote_devices_trust.json` | Trusted controller keys + per-controller `PermissionPolicy` + pairing queue |
| `remote_devices_enabled.json` | Master opt-in toggle (default OFF) |
| `remote_devices_audit.jsonl` | Append-only redacted audit trail |

---

## Identity

On first use the device generates:
- an **Ed25519** signing keypair — the device's identity + the key it signs
  commands with, and
- an **X25519** static keypair — the key others seal command bodies *to*.

`device_id = hex(SHA-256(ed25519_public_key))`. The id is *derived from* the key,
so a device cannot claim an id that doesn't match the key it signs with (the
target re-derives and checks this on every request). The name is user-editable
and cosmetic. Secrets are DPAPI-protected at rest; only public keys + id + name
+ capabilities are ever shareable.

## Registry & discovery

"My OwLLM Devices" is a metadata list: name, OS, arch, OwLLM version,
capabilities (shell / WSL / …), last-seen, online/offline, trusted/untrusted.

Discovery is intended to piggyback on the existing **vault** (the private
`owllm-vault` git repo already used for GPU-server sharing — `vault.rs`
`GpuServer` is the single-record precursor). Each device publishes a
**public-only** record to `state/devices/<device_id>.json`; peers on the same
GitHub account read the directory. **The vault is metadata-only and is never a
command queue** — control never flows through git. (v1 ships the local registry
and the record shape; wiring the `vault_sync_devices` channel is the documented
next step, following the `vault_sync_projects` template.)

## Transport abstraction

```rust
trait Transport {
    fn send(&self, to_device: &str, frame: &[u8]) -> Result<Vec<u8>, String>;
}
```

A `frame` is the **fully sealed + signed envelope bytes** — opaque to the
transport. v1 implements `LoopbackTransport`, which routes a frame to the local
target handler in-process. That is enough to (a) run the entire
sign→seal→route→open→verify→authorize→execute→audit pipeline end-to-end in unit
tests, and (b) let the UI drive a real *self-controlled* session (pair with your
own device, approve, run diagnostics) with zero network. The production
`RelayTransport` (an OwLLM WebSocket relay that forwards ciphertext between
devices) implements the same trait; because the relay only sees frames, swapping
it in changes **nothing** about the security properties. **SSH is an optional
compatibility mode, not the default** — it would be a third `Transport` impl.

## Sealed, signed envelope

```
SignedEnvelope {
  from_device, from_ed25519_pub,     // who is asking (id is checked against the key)
  to_device,
  ts, nonce,                         // freshness (±120s) + replay guard
  eph_x25519_pub,                    // ephemeral sender key
  gcm_nonce, ciphertext,             // AES-256-GCM(CommandRequest), AAD = header
  sig                                // Ed25519 over the canonical header
}
```

- **Seal:** ephemeral X25519 → ECDH with the target's static X25519 public key →
  `SHA-256(context ‖ shared ‖ from_pub ‖ to_device)` = AES-256 key → GCM-encrypt
  the `CommandRequest`, binding the header as AAD.
- **Sign:** Ed25519 over the canonical header (which commits to the ciphertext),
  so any tamper — including moving ciphertext to another header — fails
  verification.
- **Open (target):** re-derive the key, decrypt, verify the signature against
  `from_ed25519_pub`, check `from_device == hex(SHA-256(from_ed25519_pub))`,
  reject stale `ts` / seen `nonce`, then run the trust + policy checks.

Result: the relay is blind, forgery needs the controller's Ed25519 secret, and
reading a command needs the target's X25519 secret.

## Trust & pairing

1. Controller sends a **pairing request** (its public keys + name) to the target.
2. The target shows an **unmistakable approval dialog**. Nothing is trusted until
   a human approves.
3. On approval the controller key is stored with a **default read-only policy**;
   the user can then widen it per-controller.
4. Trust is revocable at any time (`device_trust_revoke`). A revoked key
   fails-closed on the very next request.

## Permission policy

```rust
PermissionPolicy { allow_shell, allow_wsl, allow_file_writes, allow_admin }
// Default: all false  → read-only diagnostics only
```

`authorize(kind, policy) -> Authorization`:

| CommandKind | Default | With toggle on |
|---|---|---|
| `Diagnostics` | **Allowed** (read-only) | Allowed |
| `Shell` | Denied | Allowed |
| `Wsl` | Denied | Allowed |
| `FileWrite` | Denied | **RequiresApproval** (per-action, target-side) |
| `Admin` | Denied | **RequiresApproval** (per-action, target-side) |

Dangerous kinds never run on a toggle alone — they always need a fresh
target-side approval. `authorize()` is a pure function with unit tests; it is the
single security-decision chokepoint.

## Execution, timeouts, cancellation, safety

- **Diagnostics** (always allowed): OS, arch, version, WSL availability, uptime,
  CPU/RAM summary. No side effects.
- **Shell** (gated): spawned via tokio with a hard **timeout** and registered in
  an active-session table so it can be **cancelled** / killed.
- **WSL** (gated, Windows targets): routed through the existing
  `wsl::run_in_distro_script` with a timeout; picks `best_linux_distro()`.
- **FileWrite / Admin**: authorize returns `RequiresApproval`; the v1 executor
  **refuses to run them** (returns an approval-gated error) — the decision layer
  is complete and fail-closed; wiring approved-dangerous execution is a
  deliberate next step, not an accidental gap.
- **"Being controlled" banner + Stop:** while a remote session runs the target
  emits a `remote-devices:control` event (UI shows a prominent banner).
  `device_stop_remote_control` halts all in-flight sessions immediately.
- **No secrets in logs:** audit redaction is keyed on field name and applied by
  the *only* audit constructor, so a new command can't leak by forgetting to
  opt in.

---

## What ships in v1 (this slice)

- Cryptographic **device identity** (Ed25519 + X25519), DPAPI-protected, editable name.
- **Registry** of known devices + this device's public record shape.
- **Trust store + full pairing flow** (request / approve / deny / revoke), per-controller policy.
- **Permission policy** with the four toggles, read-only default, unit-tested `authorize()`.
- **Sealed+signed envelope** crypto, unit-tested round-trip + tamper/replay rejection.
- **Executor**: diagnostics + shell + WSL, with timeout + cancellation; dangerous kinds fail-closed.
- **Transport abstraction** + `LoopbackTransport`; end-to-end **self-test** command.
- **Redacted audit** on both ends; audit viewer in the UI.
- **Devices page** (Advanced): identity card, device list, trust/pairing UI with the
  unmistakable approval prompt, permission toggles, a *visibly distinct* remote
  terminal, WSL "Run in WSL" mode, "being controlled" banner + emergency Stop.
- Master **opt-in toggle**, default OFF (env override `OWLLM_REMOTE_DEVICES`).

## Verifying the security-critical behavior

Unit tests live next to the code they guard:

- `policy.rs` — the `authorize()` matrix: read-only default, per-toggle
  unlocking, and that FileWrite/Admin never return a bare `Allowed`.
- `crypto.rs` — seal/open round-trip + rejection of wrong-recipient,
  tampered-ciphertext, forged-signature, and spoofed-device-id frames.
- `trust.rs` — fail-closed `authorized_policy` (unknown/pending/revoked/
  key-rotation all refuse).
- `audit.rs` — raw command output is never persisted (length + digest only).
- `mod.rs` — end-to-end: an authenticated-but-untrusted controller is refused,
  a disabled feature refuses before acting, a misrouted frame hard-errors.

Run: `cargo test -p owllm-desktop remote_devices`. Note: this crate is a Tauri
library, and launching its lib-test harness needs the WebView2 runtime DLLs
beside the test exe; a bare dev shell without them fails *every* test in the
crate at load with `STATUS_ENTRYPOINT_NOT_FOUND` (not a code fault — the same
happens for pre-existing tests like `pick_best_distro`). The pure crypto +
policy tests can also be run in isolation against the real source files without
linking Tauri, which is how they were verified here (11/11 passing).

## Deliberately deferred (documented, not hidden)

- `RelayTransport` (the network WebSocket relay) + `vault_sync_devices` discovery channel.
- Approved-dangerous execution (FileWrite/Admin run path).
- Persistent replay cache across restarts (v1 keeps the nonce cache in memory).
- SSH compatibility transport.
