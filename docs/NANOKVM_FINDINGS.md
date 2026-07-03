# NanoKVM SSH recon — findings

Status: **⏳ AWAITING DEVICE ACCESS.** The recon in
[NANOKVM_SSH_CHECKLIST.md](./NANOKVM_SSH_CHECKLIST.md) is **read-only** and must
run on a machine that can reach the NanoKVM on the LAN. It could **not** be run
from the build/CI sandbox (WSL behind NAT — `nanokvm.local` does not resolve and
device port 22 is unreachable from there). Run it from an on-network host, then
paste the RAW output into the fenced blocks below — nothing here is fabricated;
every block stays empty until a real capture fills it.

Each section is tied to the frozen `kvm_node_exec` contract in
[OWLLM_NODE.md](./OWLLM_NODE.md) so filling it directly feeds the slice-1
transport implementation.

---

## 0. Connection

- **Host / address used:** _(fill in — e.g. `nanokvm.local` or `192.168.x.y`)_
- **Login:** `root` / `root` (default) — note if changed.
- **Reachable:** ⏳ pending

---

## 1. What is this box? (OS + kernel)

Feeds: toolchain + capability baseline.

```text
# cat /etc/os-release

⏳ paste output
```

```text
# uname -a

⏳ paste output
```

---

## 2. Eyes: framebuffer / video-capture device

Feeds: the exact node behind the HDMI capture that backs the `screenshot`
action's PNG, plus its resolution/format.

```text
# ls -l /dev/fb* /dev/video*

⏳ paste output
```

```text
# v4l2-ctl --list-devices        (note if v4l2-ctl is absent: `which v4l2-ctl`)

⏳ paste output
```

- **Capture node chosen:** _(e.g. `/dev/video0` or `/dev/fb0`)_
- **Resolution / pixel format:** _(from v4l2-ctl)_

---

## 3. Hands: USB-HID gadget

Feeds: where `type` / `keys` / `mouse` / `boot_key` inject.

```text
# ls -l /sys/kernel/config/usb_gadget/

⏳ paste output
```

```text
# ls -l /dev/hidg*

⏳ paste output
```

- **HID gadget node(s):** _(e.g. `/dev/hidg0` = keyboard, `/dev/hidg1` = mouse)_
- **configfs gadget layout:** _(summary)_

---

## 4. Transport: the web UI's OWN websocket/API

Feeds: **this is what `kvm_node_exec` drives in slice 1** — we adopt the stock
web UI's protocol as-is (no firmware fork).

```text
# ss -tlnp

⏳ paste output
```

```text
# ps aux    (the web/app service that owns the port above)

⏳ paste output
```

- **Listening port(s):** _(from ss)_
- **Owning process / service:** _(from ps)_
- **Install dir / config location:** _(e.g. under /root, /etc, /opt)_
- **Websocket / HTTP endpoint path(s):** _(the on-device web client's transport)_
- **Message framing:** _(how the client encodes an injection / requests a frame —
  from the client source or a browser devtools capture against the UI)_

---

## Contract mapping (fill once the above is known)

| contract action | drives which device node / endpoint          |
|-----------------|----------------------------------------------|
| `screenshot`    | _(capture node from §2 → PNG)_               |
| `type`          | _(HID keyboard gadget from §3)_              |
| `keys` (`combo`)| _(HID keyboard gadget from §3)_              |
| `mouse` (`op`)  | _(HID mouse gadget from §3)_                 |
| `boot_key`      | _(HID keyboard gadget from §3)_              |
| transport       | _(websocket/API from §4)_                    |
