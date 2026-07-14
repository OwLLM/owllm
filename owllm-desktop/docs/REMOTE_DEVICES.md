# OwLLM Remote Devices / Fleet Control

Secure remote control of one OwLLM Desktop install from another. This is **not
"SSH into WSL"** — it is a device-to-device control plane where the *permission
to control a machine is a cryptographic key the target has explicitly trusted*,
not a GitHub login. GitHub account matching helps **discovery**; a paired,
signed device key is what grants **control**. WSL is just one execution
environment *inside* a Windows target.

Status: **shipped, WAN-capable, zero-setup off-LAN.** Real cross-machine control
works on the same LAN, from anywhere via the embedded P2P transport (iroh — no
account, no VPN, no port-forward), across an overlay (Tailscale/WireGuard/VPN),
to a public host you set, or through a self-hostable relay — so devices do NOT
need to be on the same network.
Module lives at `src-tauri/src/remote_devices/` (Rust) and
`ui/src/pages/advanced/DevicesPage.tsx` (UI). The name `fleet` was already taken
by git-worktree agent isolation (`fleet.rs`), so this module is `remote_devices`.

## Reaching a device off-LAN (the WAN story)

Control flows to whatever address the two machines can route to each other on.
Each device publishes ALL its candidate addresses (most WAN-reachable first) and
the controller tries each, then falls back to a relay:

1. **Overlay** — on a Tailscale/WireGuard/VPN, the device's overlay
   IP (e.g. a Tailscale `100.x`) is auto-detected and published, so direct
   control works from anywhere with automatic NAT traversal and no config here.
2. **Public endpoint** — set a per-device `host:port` (port-forward / DDNS /
   Tailscale MagicDNS); it's published as the first candidate.
3. **LAN IP** — same-network direct.
4. **Embedded P2P (recommended off-LAN — zero setup)** — iroh compiled into the
   app (`p2p.rs`): QUIC with NAT hole-punching, falling back to n0's free public
   relay fleet. No account, no login, no daemon. Each device has a dedicated
   iroh keypair (separate from the identity keypair; DPAPI-wrapped) and publishes
   its `p2p_node_id` in the device record; peers dial by id alone — and can even
   *pair* by node id typed into the Pair box. iroh's own encryption is just an
   extra shell: the frames it carries are the same sealed envelopes, so n0's
   relays see ciphertext-in-ciphertext.
5. **Relay** — a self-hostable store-and-forward server (`relay.rs`, or an
   always-on OwLLM instance via `device_relay_serve`). BOTH devices dial OUT to
   it, so it works behind any NAT. The relay only ever moves ciphertext and
   matches replies by correlation id — it can't read, forge, or replay anything.

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
  executor.rs    Diagnostics / shell / WSL / FileWrite exec, timeout + cancellation
  transport.rs   Transport trait + LoopbackTransport (self) + LanDirectTransport (peer)
  lan.rs         tiny_http listener + reqwest client (the LAN-direct wire)
  p2p.rs         Embedded P2P (iroh): hole-punching QUIC + public-relay fallback,
                 dedicated keypair, dial/pair by p2p_node_id — zero-setup off-LAN
  relay.rs       Self-hostable WAN relay: RelayTransport + client loop + serve()
  audit.rs       Redacted append-only JSONL, both sides (+ redaction tests)
```

Files on disk (all under `paths::user_data_root()`, none synced):

| File | Contents |
|---|---|
| `remote_device_identity.json` | This device's id, name, DPAPI-wrapped Ed25519 + X25519 secrets, public keys |
| `remote_devices_registry.json` | Known peer devices (public metadata + LAN endpoint) |
| `remote_devices_trust.json` | Trusted controller keys + per-controller `PermissionPolicy` + pairing queue |
| `remote_devices_enabled.json` | Master opt-in toggle (default OFF) |
| `remote_devices_seen.json` | Persistent replay-nonce cache (pruned to the freshness window) |
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

Discovery piggybacks on the existing **vault** (the private `owllm-vault` git
repo already used for GPU-server sharing). `vault_sync_devices` (a fourth vault
channel, built on the `vault_sync_projects` template) publishes each device's
**public-only** record — including its LAN endpoint — to
`state/devices/<device_id>.json` and pulls peers' records into the local
registry. It runs at launch and on tab-hide (wired in `vaultSync.ts`), and the
Devices page has a manual **🔄 Discover** button. Three things keep published
endpoints fresh (their staleness was the "no known LAN endpoint" pair failure):
the listener starts at app **launch** when the feature is enabled
(`remote_devices::init` in lib.rs setup), so the launch-time publish carries
dialable addresses; toggling remote control **republishes immediately**; and
`device_request_pairing` **re-pulls the vault once** before reporting that a
peer has no address. **The vault is metadata-only
and is never a command queue** — control never flows through git. Records are
rejected on ingest unless their id matches their Ed25519 key.

No vault? You can still **pair by address**: type a peer's `ip:port` (LAN) or
its `p2p_node_id` (from anywhere, via the embedded P2P transport) and the two
devices exchange public records directly.

## Transport abstraction

```rust
trait Transport {
    fn send(&self, to_device: &str, frame: &[u8]) -> Result<Vec<u8>, String>;
}
```

A `frame` is the **fully sealed + signed envelope bytes** — opaque to the
transport. Two transports ship today:

- **`LoopbackTransport`** — in-process, routes a frame to the local handler.
  Used for the self-test and single-machine demo.
- **`LanDirectTransport`** — POSTs the frame to a peer's HTTP listener
  (`lan.rs`, `tiny_http`) over the LAN and opens the peer's **sealed reply**. The
  listener speaks plain HTTP because the frame *and* the reply are end-to-end
  sealed; the wire carries only ciphertext. The listener runs only while the
  feature is enabled, binds `0.0.0.0:47771` (ephemeral fallback), and publishes
  `ip:port` as the device's endpoint. `device_send` picks loopback (self) vs
  LAN (peer) automatically from the target's endpoint.

Every transport gets a fresh sealed reply, so the return path is encrypted too:
the target seals the `CommandResult` back to the controller's authenticated
static X25519 key (carried, signed, in the request frame).

- **`P2pTransport`** — embedded iroh (`p2p.rs`): dials the target's
  `p2p_node_id` over hole-punched QUIC, with n0's public relays as fallback.
  Zero setup, works behind NATs and AP isolation. Same trait, same opaque
  frames — iroh's transport encryption is an *extra* layer, not a replacement.
- **`RelayTransport`** — self-hosted WAN store-and-forward for pure-NAT peers
  (see the WAN section above). Implements the same trait; because the relay only
  sees frames, it changes **nothing** about the security properties.

`route_command` picks automatically: loopback for self, then each direct
candidate (public → overlay → LAN, dead ones fail fast on the connect timeout),
then embedded P2P, then the self-hosted relay. **SSH would be an optional
compatibility mode** — one more `Transport` impl (deferred).

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
- **FileWrite / Admin** (dangerous): authorize returns `RequiresApproval`. The
  target registers a **pending approval**, emits `remote-devices:approval` (the
  UI shows a prominent prompt), and the command **waits** on a `oneshot` for a
  human `device_approve_action` / `device_deny_action` — or a 120s timeout →
  denied. Only on explicit approval does `executor::execute_dangerous` run it
  (FileWrite = write the base64 payload to the path; Admin = an audited
  privileged shell). Nothing dangerous runs on a toggle alone.
- **"Being controlled" banner + Stop:** while a remote session runs the target
  emits a `remote-devices:control` event (UI shows a prominent banner).
  `device_stop_remote_control` halts all in-flight sessions immediately.
- **No secrets in logs:** audit redaction is keyed on field name and applied by
  the *only* audit constructor, so a new command can't leak by forgetting to
  opt in.

---

## What ships

- Cryptographic **device identity** (Ed25519 + X25519), DPAPI-protected, editable name.
- **Registry** of known devices; auto-populated across the account via `vault_sync_devices`.
- **WAN-capable transport** — direct over LAN / overlay (Tailscale) / public host, then a
  self-hostable relay; multi-candidate try-all routing; sealed request AND reply.
- **Trust store + full pairing flow** (request / approve / deny / revoke) — over the wire and by IP.
- **Permission policy** with the four toggles, read-only default, unit-tested `authorize()`.
- **Sealed+signed envelope** crypto, unit-tested round-trip + tamper/replay rejection.
- **Executor**: diagnostics + shell + WSL + FileWrite, with timeout + cancellation.
- **Approved-dangerous execution** — FileWrite/Admin run only after a live target-side approval.
- **Persistent replay cache** — survives restart (pruned to the freshness window).
- **Redacted audit** on both ends; audit viewer in the UI.
- **Devices page** (Advanced): identity + listener status, device list with Discover +
  pair-by-IP, unmistakable pairing AND dangerous-action approval prompts, permission
  toggles, a *visibly distinct* remote console (diagnostics / shell / Run-in-WSL /
  File write), "being controlled" banner + emergency Stop.
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

- **SSH compatibility transport** (a fourth `Transport` impl).
- Real elevation for Admin (UAC/sudo) beyond an audited privileged shell.
- A hosted OwLLM relay service (today the relay is self-hosted — run it on any
  always-on box with a public URL/tunnel, or via `device_relay_serve`).
- Concurrency: the LAN listener processes one request at a time (a dangerous action
  awaiting approval blocks the queue up to its timeout) — fine now, revisit for large fleets.
