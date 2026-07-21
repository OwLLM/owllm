#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
SUDO_PASS="!Farvision."
_run_sudo() { echo "$SUDO_PASS" | sudo -S "$@"; }
cd /home/farisland/OwLLM
exec > >(tee -a setup-build.log) 2>&1

echo "=== updating apt ==="
_run_sudo apt-get update -y

echo "=== installing Tauri system deps ==="
_run_sudo apt-get install -y \
  build-essential curl wget git file patchelf libfuse2 \
  libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev \
  libglib2.0-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
  libssl-dev pkg-config lsb-release

echo "=== installing Node.js ==="
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x -o /tmp/nodesource_setup.sh
  _run_sudo bash /tmp/nodesource_setup.sh
  _run_sudo apt-get install -y nodejs
fi
node --version
npm --version

echo "=== installing Rust ==="
if ! command -v cargo >/dev/null 2>&1; then
  curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup.sh
  sh /tmp/rustup.sh -y --default-toolchain stable
fi
source "$HOME/.cargo/env"
cargo --version
rustc --version

echo "=== installing cargo-tauri ==="
source "$HOME/.cargo/env"
cargo install tauri-cli --locked

echo "=== installing gh CLI ==="
if ! command -v gh >/dev/null 2>&1; then
  _run_sudo mkdir -p -m 755 /etc/apt/keyrings
  out=$(mktemp)
  wget -nv -O "$out" https://cli.github.com/packages/githubcli-archive-keyring.gpg
  _run_sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg < "$out" > /dev/null
  _run_sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages $(lsb_release -cs) main" | _run_sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
  _run_sudo apt-get update -y
  _run_sudo apt-get install gh -y
fi
gh --version

echo "=== installing npm deps ==="
cd owllm-desktop
npm ci

echo "=== SETUP COMPLETE ==="
