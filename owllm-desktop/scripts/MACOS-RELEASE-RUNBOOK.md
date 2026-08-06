# macOS release runbook

Run on the paired Mac (MacBook Air, Apple Silicon). CI cannot do this while the
GitHub Actions billing block is in place, and the Developer ID private key lives
only in that machine's keychain.

## The rule: macOS ships ONE universal bundle

`--target universal-apple-darwin`, never a single arch. Every macOS build before
v1.0.6 was aarch64-only, so `latest.json` never carried a `darwin-x86_64` key and
Intel Macs were never offered an update, on any version.

`publish-release.sh` now enforces this: it builds universal, runs `lipo -archs`
on the bundled Mach-O and fails the publish if both slices are not present, then
registers **both** `darwin-aarch64` and `darwin-x86_64` against the single
`OwLLM.Desktop_universal.app.tar.gz`.

Pinned by `ui/src/pages/agentic/releaseArtifactVersion.verify.run.mjs`.

## Two things that are not obvious

**1. Nested Mach-O binaries must be universal too.** `resources/runtime/whisper.cpp/`
holds `whisper-cli` and `main`, built locally by cmake. A cmake default build is
host-arch only, so a "universal" app would still ship an arm64-only helper that
cannot execute on Intel at all (Rosetta translates x86_64 *to* arm, not back):

```bash
cmake -S <whisper-src> -B <build> -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES="arm64;x86_64" \
  -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_SERVER=OFF -DWHISPER_BUILD_EXAMPLES=ON
```

Quote the arch list. Unquoted, `;` is a shell separator and the build silently
configures arm64 only. Verify with `lipo -archs`, never by assuming.

**2. Unlocking the keychain is not enough.** Without
`security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k <pw> <kc>`
the private key prompts on every use — `codesign` then blocks forever behind a
modal `SecurityAgent` dialog and takes the Mac's GUI with it. Always run the
partition-list step after unlocking, and never run `security show-keychain-info`
(it prompts too).

## Module registry

`modules::Platform` gained `MacOsX86_64`, but `data/modules/registry.json` has no
`macos-x86_64` variants yet (`local-inference`, `audio-stt`, `python-runtime`,
`mcp-toolchain` are all arm64-only on macOS). On an Intel Mac those modules
correctly report "no build published" instead of handing out arm64 binaries —
cloud/API models work, local llama-server does not, until x64 module zips are
published.

## Verify before promoting

```bash
lipo -archs "<app>/Contents/MacOS/owllm-desktop"   # must print: x86_64 arm64
xcrun stapler validate "<dmg>"                      # tauri leaves the dmg unstapled
spctl -a -t open --context context:primary-signature -vv "<dmg>"
curl -sL .../latest.json                            # darwin-aarch64 AND darwin-x86_64
```
