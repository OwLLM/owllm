# NanoKVM SSH recon checklist

Run these **once we can SSH into the NanoKVM** (default login `root` / `root`).
The goal is to discover the three things the [OWLLM Node](./OWLLM_NODE.md)
depends on:

1. what the box is (OS / kernel),
2. its **eyes** — the HDMI framebuffer / video-capture device,
3. its **hands** — the USB-HID gadget path, and
4. its **transport** — the web UI's OWN websocket/API, which is what
   `kvm_node_exec` will drive (slice 1 = **stock web-UI protocol, no firmware
   fork**).

Capture the output of every command — it feeds the slice-1 transport
implementation. These are **read-only recon** commands; none reflash or modify
the device.

```bash
# --- 0. Connect ---
ssh root@<NANOKVM_HOST>          # password: root

# --- 1. What is this box? (OS + kernel) ---
cat /etc/os-release
uname -a

# --- 2. Eyes: framebuffer / video-capture device ---
ls -l /dev/fb* /dev/video*
v4l2-ctl --list-devices          # if v4l2-ctl is absent, note it; try: which v4l2-ctl

# --- 3. Hands: USB-HID gadget ---
ls -l /sys/kernel/config/usb_gadget/     # the configfs gadget(s) the device exposes
ls -l /dev/hidg*                         # the HID gadget char devices we write to

# --- 4. Transport: the web UI's OWN websocket/API ---
ss -tlnp                          # listening TCP ports + the process holding each
#   -> identify the NanoKVM web/app service and its port(s)
ps aux                            # what the web/app service actually is
#   Then inspect that service's config + how its web client talks to it:
#   - locate its install dir / config (e.g. under /root, /etc, /opt — grep for the port from ss)
#   - note the websocket/HTTP endpoint paths and message framing its client uses
#     (the on-device web client source, or a browser devtools capture against the UI)
```

## What to record

- **OS/kernel** (`/etc/os-release`, `uname -a`) — toolchain + capability baseline.
- **Capture device** — the exact `/dev/fbN` or `/dev/videoN` node behind the
  HDMI capture, and its resolution/format (from `v4l2-ctl`). This is what
  ultimately backs the `screenshot` action's PNG.
- **HID gadget** — the `/dev/hidgN` node(s) and the configfs gadget layout, so we
  know where `type` / `keys` / `mouse` / `boot_key` inject.
- **Web-UI transport** — the listening port(s) from `ss -tlnp`, the owning
  process, its config, and the **websocket/API protocol** its own web client
  speaks. **That transport is what `kvm_node_exec` drives** in slice 1 — we adopt
  it as-is rather than forking firmware.

Keep the findings consistent with the frozen `kvm_node_exec` contract in
[OWLLM_NODE.md](./OWLLM_NODE.md).
