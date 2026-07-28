# OWLLM Node — thin hands-and-eyes projector

This document describes the **OWLLM Node**: a way for an OwLLM agent to see and
drive a *physical, headless* machine over the network through a
[Sipeed NanoKVM](https://wiki.sipeed.com/nanokvm), with the intelligence staying
on the OwLLM host. For the app's overall design see
[ARCHITECTURE.md](./ARCHITECTURE.md).

Status: **slice 1** — the tool contract below is **FROZEN**. Some actions are
live, some are stubs (marked). There is **NO firmware fork in slice 1**: we drive
the **stock NanoKVM web-UI websocket/API**. We do not build or flash custom
NanoKVM firmware.

---

## 1. The split: thin device, remote brain

The NanoKVM is a **thin projector of hands and eyes** — nothing more:

- **Eyes.** The NanoKVM captures the target's **HDMI framebuffer**. We take that
  captured frame as a PNG and feed it into OwLLM's **existing screenshot + VLM
  (mmproj) path** — the same pipeline the agent already uses to look at images.
  The device does no reasoning; it just hands us pixels.
- **Hands.** The NanoKVM presents a **USB-HID gadget** to the target (it looks
  like a plugged-in keyboard + mouse). We drive it to emit **keystrokes and
  mouse events**. Again: no logic on the device, just input injection.

The **brain runs on the OwLLM host / control plane** — the agent loop, the VLM,
the decision-making. The target machine sees only a keyboard, a mouse, and a
video-capture tap. It never runs OwLLM code and needs no OwLLM software
installed; it doesn't even have to be powered by the same OS (or booted at all,
for boot-key/power actions).

This is the same decoupling principle as the rest of OwLLM (hard-to-place
capability stays where it must, the agent reaches it over the network) applied to
*a physical box we don't control*.

---

## 2. The two integration surfaces

1. **Eyes → the existing VLM path.** `screenshot` returns an **absolute PNG
   path** on the host. From there it flows through the same screenshot + VLM
   (mmproj) machinery the agent already uses to look at images — no new vision
   plumbing. The Node is just another producer of a PNG for that path.
2. **Hands + control → the `kvm_node_exec` host executor.** Every injection and
   control action (type, keys, mouse, boot_key, and the mount_iso/power stubs)
   goes through a single Rust host command. That command speaks the NanoKVM's
   **own** websocket/API transport (see §5) — we adopt the stock web UI's
   protocol rather than inventing one.

---

## 3. The FROZEN tool contract

Quoted verbatim from the slice-1 contract. This shape is **frozen** — do not
change signatures; only fill in stubs.

```
kvm_node_exec(target: KvmTarget, action, params) -> { ok, action, data?, error? }
```

Implemented as a Rust Tauri command in `src-tauri/src/kvm.rs`:

```rust
#[tauri::command]
async fn kvm_node_exec(
    target: KvmTarget,
    action: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String>
```

### KvmTarget

```
KvmTarget = {
  host,                                  // the NanoKVM address
  port?,                                 // optional
  auth: { sshKeyPath? | token? },        // one of: an SSH key path, or a token
  transport: "websocket" | "ssh"
}
```

### Actions

Every result is `{ ok, action, data?, error? }`.

| action        | params            | data (on ok)                                          |
|---------------|-------------------|-------------------------------------------------------|
| `screenshot`  | `{}`              | `{ ok, imagePath (ABSOLUTE PNG), width, height }`      |
| `type`        | `{ text }`        | —                                                     |
| `keys`        | `{ combo }`       | —                                                     |
| `mouse`       | `{ op, x, y, button? }` | —                                               |
| `boot_key`    | `{ key }`         | —                                                     |
| `mount_iso`   | (stub)            | — *(not implemented in slice 1)*                      |
| `power`       | (stub)            | — *(not implemented in slice 1)*                      |

- **`screenshot`** is the eyes: it returns an **absolute PNG path** plus the
  frame `width`/`height`. This is the only action that returns image data, and it
  is the entry point into the existing VLM path.
- **`type` / `keys` / `mouse` / `boot_key`** are the hands: text entry, key
  combos, pointer ops, and firmware/boot-menu keys — all injected over USB-HID.
- **`mount_iso` / `power`** are **stubs** in slice 1: the contract slot exists so
  the shape is frozen, but the behavior is not implemented yet.

---

## 4. Security model

The Node can move a real mouse and type real keystrokes on a real machine, so it
is gated hard.

1. **Feature flag — default OFF.** The whole Node capability is behind a feature
   flag that ships **disabled**. With it off, `kvm_node_exec` is unavailable.
2. **Per-host consent gate — fails closed, independent of the flag.** Every
   **injection** action (`type`, `keys`, `mouse`, `boot_key`, and the
   control stubs) requires per-host consent and **fails closed** if consent is
   absent — even if the feature flag is on. The gate is enforced *independently*
   of the flag; the flag is not a substitute for consent.
   - **`screenshot` is exempt** from the consent gate: looking is read-only.
     Injection is what requires consent.
3. **Audit redaction is the serializer default.** Anything logged/audited is
   redacted by default at serialization time:
   - **tokens** → redacted,
   - **`sshKeyPath`** → **path only** (the key path may appear; the key never),
   - **keystrokes** → **hashed** (we record that keys were sent, not what).

### Scope limit

`kvm_node_exec` is a **host / local-agent** capability only. **Subscription-CLI
agents cannot reach the host executor** — the command is not exposed to them.
Only an agent running on the OwLLM host (or a trusted local agent) can drive a
Node.

---

## 5. What we actually talk to (slice 1)

**No firmware fork.** We drive the **stock NanoKVM web-UI websocket/API**. The
NanoKVM already ships a web client that talks to an on-device service over a
websocket/HTTP protocol to stream video and inject HID events; `kvm_node_exec`
drives **that same transport**. Slice 1 adopts the device as-is — no custom
firmware, no reflash.

The exact ports, endpoints, and message framing to drive are captured on the
device itself — see [NANOKVM_SSH_CHECKLIST.md](./NANOKVM_SSH_CHECKLIST.md) for
the commands that discover the framebuffer/capture device, the USB-HID gadget
path, and the web UI's own listening protocol. That discovered transport is what
this contract binds to.
