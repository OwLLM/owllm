# Install OWLLM on Linux

You do not need to choose from GitHub's release-asset list. Use the two short
steps below to get the package made for your machine.

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

This is the recommended package for Debian-based systems.

| Your architecture | Download |
|---|---|
| x86-64 | [Download the x86-64 `.deb`](https://github.com/OwLLM/owllm/releases/latest/download/OwLLM.Desktop.deb) |
| ARM64 | [Download the ARM64 `.deb`](https://github.com/OwLLM/owllm/releases/latest/download/OwLLM.Desktop.arm64.deb) |

After the download, double-click the file and open it with your software
installer, or use the matching Terminal command:

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

The AppImage does not install system-wide. Download the file for your
architecture:

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

- Typical Ubuntu/Debian PC: use the **x86-64 `.deb`**.
- NVIDIA Jetson running Ubuntu: use the **ARM64 `.deb`**.
- Fedora/RHEL: use the matching **`.rpm`**.
- Everything else: use the matching **AppImage**.

The files named `latest.json` and `.app.tar.gz` on GitHub are internal
auto-update files, not installers. The source-code archives are also not needed
to install OWLLM.

For older versions, release notes, and checksums, see
[all OWLLM releases](https://github.com/OwLLM/owllm/releases).
