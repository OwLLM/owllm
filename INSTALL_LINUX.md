# Install OWLLM on Linux

You do not need to choose from GitHub's release-asset list. Use the two short
steps below to get the package made for your machine.

> **Just want the link?** [**DOWNLOAD.md**](https://github.com/OwLLM/owllm/blob/main/DOWNLOAD.md)
> has one permanent link per machine.
>
> **Want OwLLM to keep itself up to date?** Choose the **AppImage**. It is the only
> Linux package the in-app updater can replace by itself — a `.deb` or `.rpm` install
> can tell you a new version exists but cannot install it, so you have to download the
> new package by hand each time.

## 1. Check your processor architecture

Open Terminal and run:

```bash
uname -m
```

- `x86_64` means **x86-64** (most Intel and AMD desktop/laptop PCs).
- `aarch64` or `arm64` means **ARM64** (for example NVIDIA Jetson and many
  ARM development boards).

## 2. Choose your Linux family

### Ubuntu, Debian, Linux Mint, Pop!_OS, or another Debian-based system

This integrates with your application menu and software installer. Note that a
`.deb` install **cannot update itself** — pick the AppImage below if you would rather
OwLLM handled its own updates.

| Your architecture | Download |
|---|---|
| x86-64 | [Download the x86-64 `.deb`](https://github.com/OwLLM/owllm/releases/latest/download/OwLLM.Desktop.deb) |
| ARM64 | [Download the ARM64 `.deb`](https://github.com/OwLLM/owllm/releases/latest/download/OwLLM.Desktop.arm64.deb) |

After the download, double-click the file and open it with your software
installer. If double-click opens an archive viewer instead, that Linux install
does not have a package installer registered; do not extract the archive. Use
the matching Terminal command:

```bash
# x86-64
sudo apt install ~/Downloads/OwLLM.Desktop.deb

# ARM64
sudo apt install ~/Downloads/OwLLM.Desktop.arm64.deb
```

### Fedora, RHEL, Rocky Linux, or another RPM-based system

| Your architecture | Download |
|---|---|
| x86-64 | [Download the x86-64 `.rpm`](https://github.com/OwLLM/owllm/releases/latest/download/OwLLM.Desktop.x86_64.rpm) |
| ARM64 | [Download the ARM64 `.rpm`](https://github.com/OwLLM/owllm/releases/latest/download/OwLLM.Desktop.aarch64.rpm) |

Then use the matching Terminal command:

```bash
# x86-64
sudo dnf install ~/Downloads/OwLLM.Desktop.x86_64.rpm

# ARM64
sudo dnf install ~/Downloads/OwLLM.Desktop.aarch64.rpm
```

### Another Linux distribution, or a portable copy

The AppImage runs on any Linux distribution without installing anything, and it is
the only Linux package that **updates itself from inside the app**. Download the file
for your architecture:

| Your architecture | Download |
|---|---|
| x86-64 | [Download the x86-64 AppImage](https://github.com/OwLLM/owllm/releases/latest/download/OwLLM.Desktop.AppImage) |
| ARM64 | [Download the ARM64 AppImage](https://github.com/OwLLM/owllm/releases/latest/download/OwLLM.Desktop.aarch64.AppImage) |

Then use the matching commands:

```bash
# x86-64
cd ~/Downloads
chmod +x OwLLM.Desktop.AppImage
./OwLLM.Desktop.AppImage

# ARM64
cd ~/Downloads
chmod +x OwLLM.Desktop.aarch64.AppImage
./OwLLM.Desktop.aarch64.AppImage
```

## Not sure which one to use?

- **Want automatic updates (recommended): use the matching AppImage.** It is the only
  Linux package OwLLM can update by itself.
- Typical Ubuntu/Debian PC and you prefer a system package: use the **x86-64 `.deb`**.
- NVIDIA Jetson / Thor running Ubuntu: use the **ARM64 AppImage**, or the **ARM64 `.deb`**
  if you would rather install it system-wide and update it by hand.
- Fedora/RHEL: use the matching **`.rpm`**, or the AppImage for automatic updates.

The files named `latest.json` and `.app.tar.gz` on GitHub are internal
auto-update files, not installers. The source-code archives are also not needed
to install OWLLM.

For older versions, release notes, and checksums, see
[all OWLLM releases](https://github.com/OwLLM/owllm/releases).
