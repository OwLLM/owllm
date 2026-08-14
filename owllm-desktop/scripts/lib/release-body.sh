# release-body.sh — compose the GitHub release body out of its two halves.
#
# WHY: the "## Platform builds" table is a FACT about what each OS actually gets
# from a release (a fresh build, or a binary carried forward from an older tag).
# publish-release.sh computed it up front, folded it into $BODY, and then — on the
# "release already exists" path — only wrote $BODY when the existing body looked
# like a placeholder. v1.0.19 was published into a release object that had already
# been created with the body "OwLLM Desktop 1.0.19". That shape was not in the
# placeholder list, so the body was left alone and the table was silently thrown
# away. The one recent release where all four platforms were genuinely fresh is
# the only one showing no coverage table at all.
#
# The two halves have different rules, so they are handled separately:
#   changelog — prose, may be hand-written → protected, only replaced when the
#               existing body carries nothing a human would miss
#   coverage  — a disclosure, never authored by hand → rewritten on EVERY publish
#
# Consumed by publish-release.sh; exercised by releaseBody.verify.run.mjs.

COVERAGE_HEADING='## Platform builds'

# Drop trailing blank lines (stdin → stdout) so the coverage section always
# attaches with exactly one blank line above it.
_trim_trailing_blank() {
  awk '{ lines[NR] = $0; if ($0 ~ /[^ \t\r]/) last = NR }
       END { for (i = 1; i <= last; i++) print lines[i] }'
}

# cp437 renderings of the U+20xx punctuation that turns up in commit subjects,
# each paired with the character it must become. Written as octal escapes so
# this file stays pure ASCII and cannot itself be re-corrupted.
#
# WHY: a release body assembled in Windows PowerShell 5.1 arrives double-encoded.
# PS 5.1 decodes a native command's stdout with [Console]::OutputEncoding, which
# defaults to the OEM codepage (437), so git's UTF-8 "—" (\342\200\224) is read
# as three cp437 characters and re-emitted as "ΓÇö". Reproduced on the hub:
# capturing the subject of 2c797160 through PowerShell yields U+0393 U+00C7
# U+00F6 exactly where the em dash was. v1.0.20's published body carries that,
# plus the UTF-8 BOM and CRLF that Out-File adds; v1.0.18/.19, published through
# these bash scripts, carry none of it. Every mojibake sequence begins \316\223
# \303\207 (Γ Ç), which no real changelog line contains.
_MOJIBAKE_MAP='\316\223\303\207\303\264|\342\200\223
\316\223\303\207\303\266|\342\200\224
\316\223\303\207\303\277|\342\200\230
\316\223\303\207\303\226|\342\200\231
\316\223\303\207\302\243|\342\200\234
\316\223\303\207\302\245|\342\200\235
\316\223\303\207\303\263|\342\200\242
\316\223\303\207\302\252|\342\200\246'

# _sanitize_prose <text>
# Undo the transport damage above: strip a leading UTF-8 BOM, drop CR, and put
# the mangled punctuation back. Applied to whatever prose is about to be
# published, so the next release through this pipeline repairs a body that an
# ad-hoc PowerShell step poisoned instead of inheriting it forever.
_sanitize_prose() {
  local bom script from to
  bom="$(printf '\357\273\277')"
  script="1s/^$bom//"
  while IFS='|' read -r from to; do
    [ -n "$from" ] || continue
    script="$script;s/$(printf '%b' "$from")/$(printf '%b' "$to")/g"
  done <<MOJIBAKE
$_MOJIBAKE_MAP
MOJIBAKE
  printf '%s' "${1-}" | tr -d '\r' | sed "$script"
}

# body_is_placeholder <body> <tag> <version>
# 0 when the body holds no hand-written changelog and may be overwritten.
# Covers the title-shaped bodies an ad-hoc `gh release create --notes` produces —
# that is what v1.0.16/.17/.19 were published with.
body_is_placeholder() {
  local norm tag="${2-}" version="${3-}"
  # Sanitize first: a BOM in front of "OwLLM Desktop 1.0.20" would otherwise
  # make a placeholder body look hand-written and freeze it forever.
  norm="$(_sanitize_prose "${1-}" | tr -d ' \t\r\n')"
  [ -z "$norm" ] && return 0
  case "$norm" in
    "$tag"|"$version"|"v$version") return 0 ;;
    "Release$version"|"Releasev$version"|"Release$tag") return 0 ;;
    "OwLLMDesktop$version"|"OwLLMDesktopv$version") return 0 ;;
    "OwLLM.Desktop$version"|"OwLLM.Desktopv$version") return 0 ;;
  esac
  return 1
}

# strip_coverage_section <body>
# Remove a previously published "## Platform builds" section (heading through to
# the next heading, or end of body) so the fresh one never appends a duplicate.
strip_coverage_section() {
  printf '%s\n' "${1-}" | awk -v h="$COVERAGE_HEADING" '
    $0 == h { drop = 1 }
    drop && $0 != h && /^#{1,6} / { drop = 0 }
    !drop { print }
  ' | _trim_trailing_blank
}

# compose_release_body <notes> <coverage_md> [existing_body] [tag] [version]
# Prints the body to publish. The changelog half is the existing body when a
# human wrote one, else the derived notes; the coverage half is always the
# freshly computed table.
compose_release_body() {
  local notes="${1-}" coverage="${2-}" existing="${3-}" tag="${4-}" version="${5-}" prose
  if [ -n "$existing" ] && ! body_is_placeholder "$existing" "$tag" "$version"; then
    prose="$(strip_coverage_section "$(_sanitize_prose "$existing")")"
  else
    prose="$(_sanitize_prose "$notes" | _trim_trailing_blank)"
  fi
  if [ -n "$coverage" ]; then
    printf '%s\n\n%s\n' "$prose" "$(printf '%s\n' "$coverage" | _trim_trailing_blank)"
  else
    printf '%s\n' "$prose"
  fi
}
