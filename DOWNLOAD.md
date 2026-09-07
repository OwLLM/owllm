# Download OwLLM

Current release: **1.0.43**. The links on this page are permanent — they always point at the newest release, so you can bookmark or share any of them.

## Pick your machine

Pick the row for your machine. **These links never change** — they always serve the newest release.

**Windows**

| Your machine | File | Download | Auto-updates |
| --- | --- | --- | --- |
| Windows 10 / 11 — Intel or AMD 64-bit ⭐ | Installer (.exe) | [OwLLM.Desktop.Setup.exe](https://github.com/OwLLM/owllm/releases/latest/download/OwLLM.Desktop.Setup.exe) | yes |
| Windows — portable, no installation | Portable (.exe) | [OwLLM-Desktop-portable-x86_64-pc-windows-msvc.exe](https://github.com/OwLLM/owllm/releases/latest/download/OwLLM-Desktop-portable-x86_64-pc-windows-msvc.exe) | no — reinstall to update |

**macOS**

| Your machine | File | Download | Auto-updates |
| --- | --- | --- | --- |
| macOS — Apple Silicon and Intel ⭐ | Disk image (.dmg) | [OwLLM.Desktop.Setup.dmg](https://github.com/OwLLM/owllm/releases/latest/download/OwLLM.Desktop.Setup.dmg) | yes |

**Linux — Intel / AMD 64-bit**

| Your machine | File | Download | Auto-updates |
| --- | --- | --- | --- |
| Any Linux — Intel or AMD 64-bit ⭐ | AppImage | [OwLLM.Desktop.AppImage](https://github.com/OwLLM/owllm/releases/latest/download/OwLLM.Desktop.AppImage) | yes |
| Ubuntu / Debian — Intel or AMD 64-bit | Package (.deb) | [OwLLM.Desktop.deb](https://github.com/OwLLM/owllm/releases/latest/download/OwLLM.Desktop.deb) | no — reinstall to update |
| Fedora / RHEL / openSUSE — Intel or AMD 64-bit | Package (.rpm) | [OwLLM.Desktop.x86_64.rpm](https://github.com/OwLLM/owllm/releases/latest/download/OwLLM.Desktop.x86_64.rpm) | no — reinstall to update |

**Linux — ARM64**

| Your machine | File | Download | Auto-updates |
| --- | --- | --- | --- |
| Any Linux on ARM64 — NVIDIA Jetson / Thor, Raspberry Pi, ARM servers ⭐ | AppImage | [OwLLM.Desktop.aarch64.AppImage](https://github.com/OwLLM/owllm/releases/latest/download/OwLLM.Desktop.aarch64.AppImage) | yes |
| Ubuntu / Debian on ARM64 | Package (.deb) | [OwLLM.Desktop.arm64.deb](https://github.com/OwLLM/owllm/releases/latest/download/OwLLM.Desktop.arm64.deb) | no — reinstall to update |
| Fedora / RHEL on ARM64 | Package (.rpm) | [OwLLM.Desktop.aarch64.rpm](https://github.com/OwLLM/owllm/releases/latest/download/OwLLM.Desktop.aarch64.rpm) | no — reinstall to update |

⭐ = the one to pick if you are unsure. On Linux the **AppImage** is starred because it is the only
Linux package the in-app updater can replace by itself; `.deb` and `.rpm` installs must be re-downloaded
to update.

Everything below this section is the raw file list for every OS at once — you do not need it.

## Installing

**Windows** — run the `.exe` and follow the installer. It updates itself from then on.

**macOS** — open the `.dmg` and drag OwLLM to Applications.

**Linux (AppImage — recommended)** — make it executable and run it:

```bash
chmod +x OwLLM.Desktop.AppImage   # or OwLLM.Desktop.aarch64.AppImage on ARM64
./OwLLM.Desktop.AppImage
```

**Linux (`.deb`)** — `sudo apt install ./OwLLM.Desktop.deb`

**Linux (`.rpm`)** — `sudo dnf install ./OwLLM.Desktop.x86_64.rpm`

> `.deb` and `.rpm` installs **cannot update themselves** — the in-app updater can only
> replace an AppImage. If you want OwLLM to keep itself current on Linux, use the AppImage.

## For scripts and tools

A machine-readable map of every download lives at [`downloads.json`](https://github.com/OwLLM/owllm/releases/latest/download/downloads.json).
It is regenerated on every release, so resolving a download from it never needs a version number.

---

Full file list and release notes: [all releases](https://github.com/OwLLM/owllm/releases).
