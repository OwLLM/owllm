# Linux auto-update runbook — TO BE RUN ON **DESKTOP-FKSSKS3**

> **Why this file exists:** DESKTOP-FKSSKS3 is the only machine that holds the
> minisign updater private key (`.tauri-keys/owllm-updater.key`). thor (ARM) and
> the fleet PCs do **not** have it, so they can build & upload Linux download
> assets but **cannot** sign the auto-update manifest. This is the reminder /
> checklist for finishing Linux auto-updates when DESKTOP-FKSSKS3 is online.

## Current status — ask the tooling, never this file

A hand-written status table here went 40+ releases stale and told people Linux
was fine when it was not. Don't add another one. The live answer, for every OS
at once:

```bash
gh api "repos/OwLLM/owllm/releases?per_page=100" --paginate --slurp > /tmp/rel.json
node scripts/platform-coverage.mjs --releases /tmp/rel.json \
  --version "$(node -e 'process.stdout.write(require("./src-tauri/tauri.conf.json").version)')" \
  --platform none
```

It prints, per platform, the version that release actually ships and how many
releases behind it is. `publish-release.sh` runs the same check before every
build and **refuses to publish** a platform more than `OWLLM_STALE_BUDGET`
(default 2) releases stale unless you pass `--allow-stale <keys>`; either way
the table lands in the GitHub release body where users can see it. `--platform
none` above just means "assume nothing was built" — a read-only view.

## Facts you need

- Release repo: **`OwLLM/owllm`**.
- Updater endpoint (baked into the app): `https://github.com/OwLLM/owllm/releases/latest/download/latest.json`
- Baked-in pubkey (the private key you sign with **must** match this):
  `minisign public key: B3FF6147 45768DDF` (base64 in `tauri.conf.json` → `plugins.updater.pubkey`).
- Signing key file: `.tauri-keys/owllm-updater.key` (empty password).
- Tauri's **Linux** updater consumes the **AppImage** (not .deb/.rpm). Each arch
  needs its own AppImage URL + signature.

## Procedure

### 1. Sign the already-uploaded aarch64 AppImage (built on thor)

```bash
cd owllm-desktop
# grab the exact asset that is already live on the release:
curl -sL -o aarch64.AppImage \
  "https://github.com/OwLLM/owllm/releases/download/v0.8.48/OwLLM.Desktop_0.8.48_aarch64.AppImage"

export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npx @tauri-apps/cli signer sign \
  --private-key "$(cat .tauri-keys/owllm-updater.key)" aarch64.AppImage < /dev/null
SIG_AARCH64="$(cat aarch64.AppImage.sig)"     # keep this
```

### 2. Build + sign + upload the x86_64 AppImage

```bash
# full x86_64 Linux build (this box has the toolchain):
npm --prefix ui ci        # if needed
npx @tauri-apps/cli build --bundles appimage
APP="src-tauri/target/release/bundle/appimage/OwLLM Desktop_0.8.48_amd64.AppImage"

npx @tauri-apps/cli signer sign \
  --private-key "$(cat .tauri-keys/owllm-updater.key)" "$APP" < /dev/null
SIG_X86_64="$(cat "$APP.sig")"                 # keep this

# upload with an arch-explicit name (mirrors the aarch64 naming):
gh release upload v0.8.48 --repo OwLLM/owllm \
  "$APP#OwLLM.Desktop_0.8.48_x86_64.AppImage"
```

### 3. Assemble the merged `latest.json` (preserve windows, add both linux arches)

> ⚠️ Do **NOT** just run `publish-release.sh` for Linux: its Linux URL is
> hardcoded single-arch (`OwLLM.Desktop.AppImage`, no arch/version), so it would
> collide the two arches and overwrite the working Windows asset name. Assemble
> the manifest explicitly instead:

```bash
# start from the live manifest so the Windows entry is preserved verbatim:
curl -sL -o latest.json \
  "https://github.com/OwLLM/owllm/releases/latest/download/latest.json"

SIG_AARCH64="$SIG_AARCH64" SIG_X86_64="$SIG_X86_64" node -e '
  const fs=require("fs");
  const m=JSON.parse(fs.readFileSync("latest.json","utf8"));
  const base="https://github.com/OwLLM/owllm/releases/download/v0.8.48/";
  m.platforms["linux-x86_64"]={signature:process.env.SIG_X86_64,
    url:base+"OwLLM.Desktop_0.8.48_x86_64.AppImage"};
  m.platforms["linux-aarch64"]={signature:process.env.SIG_AARCH64,
    url:base+"OwLLM.Desktop_0.8.48_aarch64.AppImage"};
  fs.writeFileSync("latest.json",JSON.stringify(m,null,2));
  console.log("platforms:",Object.keys(m.platforms).join(", "));'
# expect: windows-x86_64, linux-x86_64, linux-aarch64

gh release upload v0.8.48 --repo OwLLM/owllm --clobber latest.json
```

### 4. Verify

```bash
curl -sL "https://github.com/OwLLM/owllm/releases/latest/download/latest.json" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s);console.log(m.version, Object.keys(m.platforms))})'
# must print: 0.8.48 [ 'windows-x86_64', 'linux-x86_64', 'linux-aarch64' ]
```
Then launch an **older** Linux AppImage (both arches) and confirm the in-app
update prompt offers 0.8.48 and applies cleanly.

## Follow-up (optional, root-cause)

`publish-release.sh` `linux)` case uses a single-arch URL/name
(`OwLLM.Desktop.AppImage`). To automate multi-arch Linux releases later, make the
Linux `URL`/`INSTALLER`/asset name arch-explicit (e.g.
`OwLLM.Desktop_${VERSION}_${ARCH}.AppImage`) so both arches coexist in one release
and in `latest.json`. Left unchanged for now (can't be tested without the key).
