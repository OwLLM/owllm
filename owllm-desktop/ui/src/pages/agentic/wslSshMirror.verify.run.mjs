// Regression gate: agents running inside WSL must be able to use the user's own
// SSH keys.
//
// Observed 2026-08-28. OwLLM runs agent commands in three different places, and
// only one of them could reach ~/.ssh:
//
//   host project (not isolated) -> cmd /c on Windows, inherits USERPROFILE  -> OK
//   full-access WSL project     -> plain WSL, HOME=/home/<user>             -> BROKEN
//   isolated project            -> bwrap jail, HOME=~/.owllm/sbhome         -> denied BY DESIGN
//
// Measured on the dev machine: `ssh thor` from Windows cmd returned the remote
// hostname, while the same command inside WSL failed with
// "Could not resolve hostname thor: Name or service not known" — the distro
// home had a bare known_hosts and no key, no config.
//
// The fix reuses the mechanism that already mirrors the user's cloud logins
// (~/.codex, ~/.claude, ~/.gemini, ~/.kimi) from the Windows home into the WSL
// distro home: sync_logins_impl now mirrors ~/.ssh too — keys, config (CR
// stripped so a CRLF config cannot break sshd parsing), and known_hosts MERGED
// rather than overwritten so entries added inside the distro survive.
//
// The bwrap jail is deliberately NOT touched. Its whole purpose is to keep an
// agent away from the rest of the home, and its module doc names ~/.ssh as the
// thing it protects. Graduated trust already answers this: a project the user
// explicitly marks full-access runs OUTSIDE the jail and therefore gets the
// mirrored keys, while a default (jailed) project does not. This gate pins that
// boundary so it cannot erode by accident.
//
// Run from owllm-desktop/:
//   node ui/src/pages/agentic/wslSshMirror.verify.run.mjs
//   node ui/src/pages/agentic/wslSshMirror.verify.run.mjs --live   (needs WSL)
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../../../..");
const sandboxRs = fs.readFileSync(path.join(APP, "src-tauri", "src", "sandbox.rs"), "utf8");
const codePageTsx = fs.readFileSync(path.join(APP, "ui", "src", "pages", "agentic", "CodePage.tsx"), "utf8");

let failures = 0;
const check = (label, cond) => {
  if (cond) console.log(`  ok  ${label}`);
  else { console.error(`  FAIL ${label}`); failures += 1; }
};
// indexOf returns -1 for ABSENT code, which sorts before everything, so a
// missing needle would silently satisfy a naive `a < b`.
const before = (hay, a, b) => {
  const i = hay.indexOf(a), j = hay.indexOf(b);
  return i >= 0 && j >= 0 && i < j;
};

console.log("WSL SSH mirror — agents inside WSL must reach the user's SSH hosts");

// ---------------------------------------------------------------------------
// 1. The sync reports SSH as its own provider row
// ---------------------------------------------------------------------------
check('"ssh" is a mirror-report provider',
  /const PROVIDERS: \[&str; 6\] = \["codex", "claude", "gemini", "kimi", "keys", "ssh"\];/.test(sandboxRs));
check("the ssh row is labelled SSH keys, not a login",
  /"ssh" => "SSH keys",/.test(sandboxRs));
// "log in there first" is nonsense for a key you generate, not a login you perform.
check("an absent ~/.ssh does NOT tell the user to log in",
  /\(false, false\) if \*p == "ssh" =>[\s\S]{0,160}nothing to mirror/.test(sandboxRs));
check("the unit test pins one row per provider at 6",
  /assert_eq!\(r\.len\(\), 6, "one row per provider"\);/.test(sandboxRs));

// ---------------------------------------------------------------------------
// 2. The distro-side script actually mirrors ~/.ssh
// ---------------------------------------------------------------------------
check("~/.ssh is created alongside the other credential dirs",
  /mkdir -p ~\/\.codex ~\/\.claude ~\/\.gemini ~\/\.kimi ~\/\.owllm ~\/\.ssh;/.test(sandboxRs));
// sshd/ssh refuse a group- or world-readable key directory.
check("~/.ssh is chmod 700", /chmod 700 ~\/\.ssh 2>\/dev\/null;/.test(sandboxRs));
check("keys present on Windows are reported as found",
  /ls \\"\$WH\\"\/\.ssh\/id_\* >\/dev\/null 2>&1 && found=\\"\$found ssh\\";/.test(sandboxRs));
check("every id_* key is copied into the distro home",
  /for k in \\"\$WH\\"\/\.ssh\/id_\*; do \[ -f \\"\$k\\" \] && cp -f \\"\$k\\" ~\/\.ssh\/ 2>\/dev\/null; done;/.test(sandboxRs));
// A CRLF config makes ssh fail to parse Host blocks inside Linux.
check("the ssh config is copied with CR stripped",
  /\[ -f \\"\$WH\/\.ssh\/config\\" \] && sed 's\/\\\\r\$\/\/' \\"\$WH\/\.ssh\/config\\" > ~\/\.ssh\/config/.test(sandboxRs));
// Overwriting would delete host keys accepted from inside the distro.
check("known_hosts is MERGED, not overwritten",
  /cat \\"\$WH\/\.ssh\/known_hosts\\" ~\/\.ssh\/known_hosts 2>\/dev\/null \| tr -d '\\\\r' \| sort -u/.test(sandboxRs));
check("private keys land as 600", /chmod 600 ~\/\.ssh\/id_\* 2>\/dev\/null;/.test(sandboxRs));
check("public keys are restored to 644 after the blanket 600",
  /chmod 644 ~\/\.ssh\/\*\.pub 2>\/dev\/null;/.test(sandboxRs));
check("what LANDED is reported, not what was attempted",
  /ls ~\/\.ssh\/id_\* >\/dev\/null 2>&1 && syn=\\"\$syn ssh\\";/.test(sandboxRs));

// Ordering: the directory must exist before anything is written into it, and
// the copy must happen before the "did it land" probe or syn is always empty.
check("~/.ssh is created before it is chmod'ed",
  before(sandboxRs, "~/.owllm ~/.ssh;", "chmod 700 ~/.ssh"));
check("keys are copied before the landed-probe runs",
  before(sandboxRs, 'cp -f \\"$k\\" ~/.ssh/', 'syn=\\"$syn ssh\\"'));
check("the blanket 600 runs before the 644 that re-opens *.pub",
  before(sandboxRs, "chmod 600 ~/.ssh/id_*", "chmod 644 ~/.ssh/*.pub"));

// ---------------------------------------------------------------------------
// 3. The jail boundary is preserved (graduated trust, not a hole)
// ---------------------------------------------------------------------------
const runner = sandboxRs.slice(sandboxRs.indexOf("const SANDBOX_RUNNER"));
const runnerBody = runner.slice(0, runner.indexOf('"#;'));
check("the bwrap jail still does NOT bind ~/.ssh (full-access projects are the supported route)",
  runnerBody.length > 0 && !/--bind[^\n]*\.ssh/.test(runnerBody));

// ---------------------------------------------------------------------------
// 4. The user is told what the button now does
// ---------------------------------------------------------------------------
check("the Sync logins tooltip discloses SSH keys",
  /Sync your cloud logins[^"]*and your SSH keys from Windows into the sandbox/.test(codePageTsx));

// ---------------------------------------------------------------------------
// 5. --live: run the EXACT script the app ships, inside real WSL
// ---------------------------------------------------------------------------
// The script is extracted from sandbox.rs rather than retyped, so this cannot
// pass against a script shape the app no longer builds.
if (process.argv.includes("--live")) {
  const wsl = (script) =>
    spawnSync("wsl.exe", ["-e", "bash", "-s"], { input: script, encoding: "utf8" });

  // Anchor on the login-sync literal itself. `let script = format!(` also
  // matches the sandbox-runner installer earlier in the file, which would
  // extract the wrong script and "pass" while proving nothing.
  const from = sandboxRs.indexOf('"WH={wh};');
  const end = sandboxRs.indexOf("\n    );", from);
  const literal = from >= 0 && end > from ? sandboxRs.slice(from, end).trim() : "";
  const located = literal.startsWith('"WH={wh};') && literal.endsWith('"') && literal.includes("SYNCED:");
  check("the shipped login-sync script literal was located", located);
  // Refuse to EXECUTE anything we did not positively identify. An earlier
  // revision anchored on `let script = format!(`, which also matches the
  // sandbox-runner installer; it extracted that instead, ran it, and
  // overwrote ~/.owllm/run-sandboxed.sh with an unsubstituted
  // "{SANDBOX_RUNNER}" placeholder, breaking every jailed agent until the
  // runner was reinstalled.
  if (!located) {
    console.error("  FAIL refusing to run an unidentified script in WSL");
    failures += 1;
    console.log(`\nwslSshMirror: ${failures} FAILED`);
    process.exit(1);
  }

  const shQuote = (s) => `'${s.split("'").join(`'\\''`)}'`;
  // Windows home as WSL sees it. Derived, not hardcoded.
  const winHome = process.env.USERPROFILE.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
  // Preserve the user's real API-key file: the script rewrites agent_env.sh
  // from this substitution, so feeding back its current contents makes the
  // live run idempotent instead of truncating it.
  const cur = wsl("cat ~/.owllm/agent_env.sh 2>/dev/null | base64 -w0");
  const envNow = Buffer.from((cur.stdout || "").trim(), "base64").toString("utf8");

  const script = literal
    .slice(1, -1)
    .replace(/\\\r?\n\s*/g, "")          // Rust line-continuations
    .replace(/\\(.)/g, (_, c) => ({ n: "\n", t: "\t", '"': '"', "\\": "\\" }[c] ?? `\\${c}`))
    .split("{{").join("{").split("}}").join("}")
    .split("{wh}").join(shQuote(winHome))
    .split("{env_quoted}").join(shQuote(envNow));

  const run = wsl(script);
  check("the shipped script ran in WSL", run.status === 0);
  check("the report says ssh landed in the distro", /SYNCED:[^\n]*\bssh\b/.test(run.stdout || ""));

  // Every Windows key is present in the distro, byte-identical, mode 600.
  const probe = wsl(`
    cd ${shQuote(winHome)}/.ssh 2>/dev/null || exit 9
    rc=0
    for k in id_*; do
      [ -f "$k" ] || continue
      case "$k" in *.pub) want=644;; *) want=600;; esac
      [ -f "$HOME/.ssh/$k" ] || { echo "MISSING $k"; rc=1; continue; }
      a=$(sha256sum < "$k" | cut -d" " -f1); b=$(sha256sum < "$HOME/.ssh/$k" | cut -d" " -f1)
      [ "$a" = "$b" ] || { echo "DIFFERS $k"; rc=1; }
      m=$(stat -c %a "$HOME/.ssh/$k")
      [ "$m" = "$want" ] || { echo "MODE $k=$m want $want"; rc=1; }
    done
    d=$(stat -c %a "$HOME/.ssh"); [ "$d" = "700" ] || { echo "DIRMODE $d"; rc=1; }
    echo "PROBE_RC=$rc"`);
  check("every Windows key is mirrored byte-identical with correct modes",
    /PROBE_RC=0/.test(probe.stdout || ""), probe.stdout);

  // The config must be usable by ssh inside the distro: same Host blocks, no CR.
  const hosts = (s) => (s.match(/^\s*Host\s+.+$/gim) || []).map((l) => l.trim().replace(/\s+/g, " ")).sort();
  const winCfgPath = path.join(process.env.USERPROFILE, ".ssh", "config");
  if (fs.existsSync(winCfgPath)) {
    // Count CR BYTES. `grep -c ... || echo 0` prints grep's own "0" AND the
    // fallback "0", so the substitution yields "0 0" and never matches.
    const got = wsl(`cat ~/.ssh/config 2>/dev/null; echo "---CR:$(tr -cd '\\r' < ~/.ssh/config | wc -c)"`);
    const body = (got.stdout || "").split("---CR:")[0];
    check("the distro config has the same Host blocks as Windows",
      JSON.stringify(hosts(body)) === JSON.stringify(hosts(fs.readFileSync(winCfgPath, "utf8"))));
    check("the distro config contains no CR bytes",
      /---CR:0\s*$/.test((got.stdout || "").trim()));
  }

  // known_hosts merge must be additive: a distro-only entry survives a re-sync.
  const sentinel = "owllm-mirror-probe.invalid ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMirrorProbeSentinelKeyForGateOnly";
  wsl(`printf '%s\\n' ${shQuote(sentinel)} >> ~/.ssh/known_hosts`);
  const again = wsl(script);
  const kept = wsl("grep -c owllm-mirror-probe.invalid ~/.ssh/known_hosts");
  check("a re-sync keeps host keys added inside the distro",
    again.status === 0 && (kept.stdout || "").trim() === "1");
  wsl("sed -i '/owllm-mirror-probe.invalid/d' ~/.ssh/known_hosts");
  check("the probe sentinel was cleaned up",
    (wsl("grep -c owllm-mirror-probe.invalid ~/.ssh/known_hosts").stdout || "").trim() === "0");

  // agent_env.sh must be exactly what it was before this gate ran.
  const after = wsl("cat ~/.owllm/agent_env.sh 2>/dev/null | base64 -w0");
  check("the live run did not damage the API-key file",
    Buffer.from((after.stdout || "").trim(), "base64").toString("utf8") === envNow);
}

console.log(failures === 0
  ? `\nwslSshMirror: all checks passed`
  : `\nwslSshMirror: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
