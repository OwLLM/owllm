# gh resolver — make the host-side publish scripts sandbox-aware.
#
# WHY: publish-release.sh / finish-and-publish.sh run on the Windows HOST (git-bash),
# but `gh` is installed INSIDE the WSL sandbox distro, not on the host — the app's
# universal provisioner (wsl.rs::wsl_provision) apt-installs gh into Ubuntu, while the
# host is wired for GitHub through plain git+curl only (github.rs::configure_host). So
# a publish run on a machine without a host `gh` failed with "gh not on PATH" even
# though gh is present one boundary away. This bridges that boundary.
#
# Transparent by design: defines gh() so every existing `gh …` call site is unchanged,
# and have_gh() for the pre-flight guards. When a host `gh` exists (CI, a dev box that
# has it) the host path is a pure passthrough — zero behaviour change. The WSL route
# only engages when the host has no gh.
#
# LIMITATION (WSL route only): a `gh` flag VALUE that happens to match the name of an
# existing file/dir in the cwd is treated as an upload path and rewritten to its WSL
# form. The publish scripts never pass such values (only tags, repos, notes text,
# flags, and real artifact paths), so this is safe here.

# Cache the resolved WSL distro so we probe it once per run.
_OWLLM_WSL_DISTRO=""

# Path to a real host `gh` executable, or empty. `type -P` ignores the gh() function
# we define below (it reports only an on-disk file), so this never self-recurses.
_owllm_host_gh() {
  local p
  p="$(type -P gh 2>/dev/null | head -1)"
  [ -n "$p" ] && { printf '%s' "$p"; return 0; }
  for p in \
    "/c/Program Files/GitHub CLI/gh.exe" \
    "/mnt/c/Program Files/GitHub CLI/gh.exe" \
    "${ProgramFiles:-}/GitHub CLI/gh.exe" \
    "${ProgramW6432:-}/GitHub CLI/gh.exe"
  do
    [ -x "$p" ] && { printf '%s' "$p"; return 0; }
  done
  return 1
}

_owllm_wsl() { command -v wsl.exe >/dev/null 2>&1 && echo wsl.exe; }

# First WSL distro (skipping docker-desktop / system distros) that actually has gh.
# Honours OWLLM_WSL_DISTRO as an override. Cached in _OWLLM_WSL_DISTRO.
_owllm_wsl_distro() {
  [ -n "$_OWLLM_WSL_DISTRO" ] && { printf '%s' "$_OWLLM_WSL_DISTRO"; return 0; }
  if [ -n "${OWLLM_WSL_DISTRO:-}" ]; then
    _OWLLM_WSL_DISTRO="$OWLLM_WSL_DISTRO"; printf '%s' "$_OWLLM_WSL_DISTRO"; return 0
  fi
  local wsl; wsl="$(_owllm_wsl)"; [ -n "$wsl" ] || return 1
  local d
  # `wsl -l -q` prints UTF-16LE with CRs — strip NULs, then CR per line.
  while IFS= read -r d; do
    d="${d//$'\r'/}"
    [ -z "$d" ] && continue
    case "$d" in docker-desktop*) continue ;; esac
    if "$wsl" -d "$d" -- sh -c 'command -v gh >/dev/null 2>&1' >/dev/null 2>&1; then
      _OWLLM_WSL_DISTRO="$d"; printf '%s' "$d"; return 0
    fi
  done < <("$wsl" -l -q 2>/dev/null | tr -d '\000')
  return 1
}

# Token for the WSL gh (which the app does NOT gh-auth): read it from the host
# git-credentials store the app writes (github.rs::configure_host). Empty is fine —
# gh then falls back to its own config and surfaces its own auth error verbatim.
_owllm_gh_token() {
  local f t
  for f in "${HOME:-}/.git-credentials" "${USERPROFILE:-}/.git-credentials"; do
    [ -f "$f" ] || continue
    t="$(sed -n 's#https://[^:]*:\([^@]*\)@github\.com.*#\1#p' "$f" 2>/dev/null | head -1)"
    [ -n "$t" ] && { printf '%s' "$t"; return 0; }
  done
}

# True if gh is reachable at all (host binary OR a WSL distro that has it). Use this
# in place of `command -v gh` for guards, since gh() below is always defined.
have_gh() {
  [ -n "$(_owllm_host_gh)" ] && return 0
  _owllm_wsl_distro >/dev/null 2>&1
}

# Transparent gh wrapper. Host gh → passthrough. Otherwise route to the WSL distro's
# gh, translating existing local-path args to their /mnt form and handing over the
# host token.
gh() {
  local host; host="$(_owllm_host_gh)"
  if [ -n "$host" ]; then "$host" "$@"; return $?; fi

  local wsl distro; wsl="$(_owllm_wsl)"
  if [ -z "$wsl" ] || ! distro="$(_owllm_wsl_distro)"; then
    echo "gh: not on host PATH and no WSL distro with gh available" >&2
    return 127
  fi

  # Translate any argument that is an existing local path to the WSL /mnt path so
  # `gh release upload … <file>` resolves across the boundary. `cygpath -m` yields a
  # forward-slash C:/… form (no leading slash → git-bash won't mangle it as an arg).
  local -a a=(); local x m u
  for x in "$@"; do
    if [ -e "$x" ] \
       && m="$(cygpath -m "$x" 2>/dev/null)" \
       && u="$("$wsl" -d "$distro" -- wslpath -u "$m" 2>/dev/null | tr -d '\r')" \
       && [ -n "$u" ]; then
      a+=("$u")
    else
      a+=("$x")
    fi
  done

  # MSYS_NO_PATHCONV=1: stop git-bash rewriting the leading-/mnt args before wsl.exe
  # sees them. GH_TOKEN + WSLENV: pass the host token through to the sandbox gh.
  local tok; tok="$(_owllm_gh_token)"
  if [ -n "$tok" ]; then
    MSYS_NO_PATHCONV=1 GH_TOKEN="$tok" WSLENV="GH_TOKEN:${WSLENV:-}" "$wsl" -d "$distro" -- gh "${a[@]}"
  else
    MSYS_NO_PATHCONV=1 "$wsl" -d "$distro" -- gh "${a[@]}"
  fi
}
