# NanoKVM SSH recon — findings

Status: **✅ CAPTURED 2026-07-03** from a live device on the LAN
(`192.168.219.50`, SSH as `root`). The recon in
[NANOKVM_SSH_CHECKLIST.md](./NANOKVM_SSH_CHECKLIST.md) is read-only; the raw
output below is a real capture, nothing fabricated. It directly feeds the
slice-1/Phase-2 `kvm_node_exec` transport in [OWLLM_NODE.md](./OWLLM_NODE.md).

Device: **Sipeed NanoKVM** on a CVITEK/SOPHGO **RISC-V** SoC (CV1800B family —
note the `cvitask_isp` / `cvitask_vpss` / `cvitask_tpu` kernel workers = CVITEK
multimedia pipeline). Capture is **not** v4l2/framebuffer; it goes through the
proprietary CVI ISP → the `NanoKVM-Server` process, which re-encodes and streams
it. HID is a standard USB configfs gadget.

---

## 0. Connection

- **Host / address used:** `192.168.219.50` (mDNS name on device: `kvm-5bd9.local`)
- **Login:** `root` (SSH) — password set by user, not default.
- **Reachable:** ✅ yes — TCP/22 open, SSH `uid=0(root)` confirmed.

---

## 1. What is this box? (OS + kernel)

Feeds: toolchain + capability baseline.

```text
# cat /etc/os-release
NAME=Buildroot
VERSION=-g3649fe90d
ID=buildroot
VERSION_ID=2023.11.2
PRETTY_NAME="Buildroot 2023.11.2"
```

```text
# uname -a
Linux kvm-5bd9 5.10.4-tag- #39 PREEMPT Mon Feb 17 19:04:42 CST 2025 riscv64 GNU/Linux
```

- **Baseline:** Buildroot 2023.11.2, Linux 5.10.4, **riscv64**, hostname `kvm-5bd9`.
  Minimal userland (busybox); no `v4l2-ctl`, no package manager. Any on-device
  binary we ship must be **riscv64** — but slice-1 does NOT ship a device binary;
  it drives the stock `NanoKVM-Server` HTTP/WS API remotely (see §4).

---

## 2. Eyes: framebuffer / video-capture device

Feeds: the exact node behind the HDMI capture that backs the `screenshot`
action's PNG, plus its resolution/format.

```text
# ls -l /dev/fb* /dev/video*
ls: /dev/fb*: No such file or directory
ls: /dev/video*: No such file or directory
```

```text
# which v4l2-ctl ; v4l2-ctl --list-devices
(absent)
bash: v4l2-ctl: command not found
```

- **Capture node chosen:** **none directly usable.** There is no `/dev/fbN` and
  no `/dev/videoN`. HDMI capture is owned by the CVITEK ISP/VPSS pipeline
  (kernel workers `cvitask_isp_*`, `cvitask_vpss_*`) and is only exposed to
  userspace through the vendor `NanoKVM-Server` process.
- **Consequence for `screenshot`:** we do **not** read a capture node. We obtain
  a frame from the server's stream — either one JPEG from
  **`GET /api/stream/mjpeg`** (simplest for a PNG), or one decoded H.264 keyframe
  off the `/api/ws` video websocket (see §4). Slice-1 uses the MJPEG single-frame
  grab.

---

## 3. Hands: USB-HID gadget

Feeds: where `type` / `keys` / `mouse` / `boot_key` inject.

```text
# ls -l /sys/kernel/config/usb_gadget/
drwxr-xr-x  6 root root 0 Jul  3 14:40 g0

# ls -l /sys/kernel/config/usb_gadget/g0/functions/
drwxr-xr-x 2 root root 0 hid.GS0
drwxr-xr-x 2 root root 0 hid.GS1
drwxr-xr-x 2 root root 0 hid.GS2
drwxr-xr-x 3 root root 0 mass_storage.disk0
drwxr-xr-x 3 root root 0 rndis.usb0

# report_length / protocol per HID function
hid.GS0  report_length=6  protocol=1  subclass=0
hid.GS1  report_length=4  protocol=2  subclass=0
hid.GS2  report_length=6  protocol=2  subclass=0
```

```text
# ls -l /dev/hidg*
crw------- 1 root root 237, 0 /dev/hidg0
crw------- 1 root root 237, 1 /dev/hidg1
crw------- 1 root root 237, 2 /dev/hidg2
```

- **HID gadget node(s):**
  - `/dev/hidg0` (hid.GS0, protocol 1, 6-byte report) = **keyboard**
    (report = `[modifiers][reserved][keycode×… up to 6-byte report]`).
  - `/dev/hidg1` (hid.GS1, protocol 2, 4-byte report) = **relative mouse**
    (`[buttons][dx][dy][wheel]`).
  - `/dev/hidg2` (hid.GS2, protocol 2, 6-byte report) = **absolute mouse**
    (`[buttons][x_lo][x_hi][y_lo][y_hi][wheel]`).
- **configfs gadget layout:** single gadget `g0` composing keyboard + rel-mouse +
  abs-mouse HID, plus `mass_storage.disk0` (this is what backs ISO mounting) and
  `rndis.usb0` (USB-net to host).
- **Injection path for slice-1:** we do **not** write `/dev/hidgN` directly
  (that would need an on-device riscv64 helper). We send HID through the server's
  websocket / HID REST endpoints (§4), which own these gadgets. Raw `/dev/hidgN`
  writes remain the Phase-3 "firmware-assist" option if we ever ship a device binary.

---

## 4. Transport: the web UI's OWN websocket/API

Feeds: **this is what `kvm_node_exec` drives** — we adopt the stock web UI's
protocol as-is (no firmware fork).

```text
# ss -tlnp
LISTEN 0.0.0.0:22   sshd (pid 570)
LISTEN *:80         NanoKVM-Server (pid 2073)
LISTEN *:443        NanoKVM-Server (pid 2073)
LISTEN *:22         sshd (pid 570)

# relevant processes (ps aux)
2058 root /tmp/kvm_system/kvm_system          # native media/HID helper
2073 root /tmp/server/NanoKVM-Server          # HTTP/HTTPS API + web UI  (Go binary, 21 MB)
```

- **Listening port(s):** **80 (HTTP)** and **443 (HTTPS)**, both owned by
  `NanoKVM-Server`. This is the Sipeed NanoKVM server (open source:
  `github.com/sipeed/NanoKVM`, server-side is Go).
- **Install dir:** `/tmp/server/` — `NanoKVM-Server` binary, `dl_lib/`, and the
  built web client under `/tmp/server/web/` (`index.html` + `assets/*.js`).
  A companion native helper `/tmp/kvm_system/kvm_system` handles the CVI media
  path. No YAML/JSON config on disk — config is compiled in / via API.
- **Auth:** `POST /api/auth/login` with JSON `{username, password}` → returns a
  JWT (in `data.token`); subsequent calls send it as `Authorization: Bearer <jwt>`.
  Change password: `POST /api/auth/password {username, password}`.
  - **Confirmed live** (probed on-device against `https://127.0.0.1`):
    - bad creds → `HTTP 200 {"code":-2,"msg":"invalid username or password","data":null}`
    - `GET /api/stream/mjpeg` and `GET /api/vm/info` without a token → `HTTP 401`.
  - **Account store:** `/etc/kvm/pwd` =
    `{"username":"MC9","password":"$2a$10$…"}` — password is a **bcrypt** hash
    (one-way, not recoverable). Server config in `/etc/kvm/server.yaml`:
    `proto: https`, ports 80/443, `authentication: enable`, JWT
    `refreshTokenDuration: 2678400`s, TLS cert `/etc/kvm/server.crt` +
    `server.key`, no login lockout.
  - **Web login username is `MC9`** (distinct from the SSH `root` login). The
    web-UI password is **not** the SSH password and is bcrypt-stored, so it
    can't be read off the device — it's the one item needed for a live *authed*
    round-trip test of Phase-2 (see note at bottom).

### Endpoint map (extracted from the on-device web client `assets/*.js`)

**Video / screenshot**
- `GET /api/stream/mjpeg` — MJPEG stream (grab one frame → PNG for `screenshot`).
- `GET /api/stream/mjpeg/detect`, `/api/stream/mjpeg/detect/stop` — resolution detect.
- `GET /api/vm/screen` — current screen/resolution info.

**HID (keyboard + mouse)** — real-time over the websocket, config over REST:
- **`WS  /api/ws`** — the single realtime channel. Base URL built as
  `` `${scheme_ws_or_wss}/api/ws` `` with a 10 s heartbeat.
  - **Video (server→client):** binary frame, framing =
    **`[1 byte keyframe flag (1=key)] [8 bytes uint64 LE timestamp] [H.264 Annex-B/AVC payload]`**,
    decoded by WebCodecs `VideoDecoder` with codec **`avc1.42E01F`** (H.264
    Constrained Baseline). See `assets/direct.worker-*.js`.
  - **HID (client→server):** input events tagged by an enum where **`Mouse = 2`**
    (keyboard is the other tag); events carry the HID report bytes for the
    gadgets in §3. This same socket is what our node writes key/mouse events to.
- `POST /api/hid/paste` — paste a string (bulk `type`).
- `POST /api/hid/shortcut`, `GET /api/hid/shortcuts`, `POST /api/hid/shortcut/leader-key`
  — named key combos (`keys`/`boot_key`).
- `POST /api/hid/reset` — reset HID gadget; `GET/POST /api/hid/mode`.

**Power / GPIO**
- `POST /api/vm/gpio {type, duration}` — pulse power/reset line for `duration`
  ms (`type` selects power vs reset). `GET /api/vm/gpio` reads state. This is the
  `power` action.
- `POST /api/vm/system/reboot` — reboots the KVM itself (not the target).

**Storage / ISO mount**
- `POST /api/storage/image/mount {file, cdrom}` — mount an image (`cdrom` bool =
  expose as CD-ROM vs USB disk); backed by `mass_storage.disk0` (§3).
- `GET /api/storage/image`, `/api/storage/image/mounted`,
  `POST /api/storage/image/delete`, `GET /api/storage/cdrom`.
- `POST /api/download/image` (+ `/status`, `/enabled`) — pull an ISO onto the device.

**Info / misc:** `GET /api/vm/info`, `/api/vm/hardware`, `/api/vm/hdmi`
(+`/enable` `/disable` `/reset`), `/api/vm/mouse-jiggler`, `/api/vm/oled`, and a
`picoclaw` on-device agent runtime under `/api/picoclaw/*`.

---

## Contract mapping (`kvm_node_exec` → real endpoint/node)

| contract action | drives which device node / endpoint |
|-----------------|-------------------------------------|
| `screenshot`    | one frame from `GET /api/stream/mjpeg` → PNG (Phase-2 simple path); H.264 keyframe off `/api/ws` is the low-latency alt |
| `type`          | `POST /api/hid/paste` (bulk) or key events on `WS /api/ws` → hidg0 |
| `keys` (`combo`)| `POST /api/hid/shortcut` / key events on `WS /api/ws` → hidg0 |
| `mouse` (`op`)  | mouse events (enum `Mouse=2`) on `WS /api/ws` → hidg1 (rel) / hidg2 (abs) |
| `boot_key`      | key events on `WS /api/ws` → hidg0 (send early during target POST) |
| `power`         | `POST /api/vm/gpio {type, duration}` |
| `mount_iso`     | `POST /api/storage/image/mount {file, cdrom}` (+ `/api/download/image` to stage) |
| transport       | HTTPS REST + `WS /api/ws` on port 443/80, JWT from `POST /api/auth/login`; **no firmware fork, no `/dev/hidgN` writes in slice-1** |

### What this changes vs. the Phase-1 assumptions
- **No v4l2/framebuffer screenshot** — capture is server-mediated (MJPEG/H.264),
  not a raw device node. `screenshot` = HTTP frame grab, not `/dev/fb0` read.
- **HID is server-mediated too** — slice-1 speaks `/api/ws` + `/api/hid/*`, it
  does not open `/dev/hidgN`. That keeps us on the "stock web-UI protocol"
  promise and avoids shipping a riscv64 on-device binary.
- **Transport is JWT-authed REST + one websocket** on 80/443, exactly as the
  frozen contract anticipated. Phase-2 can now be written against real endpoints.

### One remaining user-only item (for a *live authed* test, not for writing Phase-2)
Structural recon above is complete and verified against the live device. The only
thing that could **not** be self-verified is an authenticated round-trip
(login → grab a real frame / send a real HID event), because the web-UI account
`MC9` has a bcrypt-stored password that is **not** the SSH password and cannot be
read off the box. To smoke-test Phase-2 end-to-end, provide the **web-UI password
for `MC9`** (the one you type into the NanoKVM web login), or set a known one on
the device. Everything needed to *write* the Phase-2 transport is already here.
