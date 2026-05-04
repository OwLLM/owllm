# Supervisor Tool Surface

The model emits structured `{action, args}` objects. The dispatcher executes them. This is the *only* way the model affects the system — no free-form shell, no arbitrary code execution.

## Design rules

1. **Every tool is idempotent or safely retryable.** If a step half-completes, re-running it must converge to the same end state.
2. **Every tool reports back a structured result.** The model needs `{ok, stdout, stderr, exit_code, side_effects}` to decide what to do next.
3. **Bounded.** Max 5 retries per failure round. Max 50 actions per install session. Hard caps prevent runaway loops.
4. **Gated by trust tier.** Each tool is tagged `safe`, `confirm`, or `danger`. Default trust policy lets the model run `safe` autonomously, requires a UI confirmation for `confirm`, and blocks `danger` outside of explicit user override.

## Action catalog

### Install / package management

| Action | Args | Trust | Notes |
| --- | --- | --- | --- |
| `install_pkg` | `{name, version?, index?, extras?}` | safe | pip install with optional custom index |
| `swap_wheel` | `{name, from_version, to_version, index?}` | confirm | uninstall + install specific version |
| `download_file` | `{url, dest, sha256?}` | safe | for wheelhouse / manual wheels |
| `install_local_wheel` | `{path}` | safe | install pre-staged .whl |
| `uninstall_pkg` | `{name}` | confirm | only when explicitly needed |

### Environment

| Action | Args | Trust | Notes |
| --- | --- | --- | --- |
| `create_venv` | `{python_version, path}` | safe | uses bundled python_runtime |
| `set_env` | `{name, value, scope: "session"\|"user"}` | confirm | persistent only with confirm |
| `pick_profile` | `{profile_id}` | safe | load known-good profile from recipes |

### Runtime repair (wraps existing self-heal primitives)

| Action | Args | Trust | Notes |
| --- | --- | --- | --- |
| `repair_runtime_bundle` | `{bundle: "llama-cpp-cuda" \| ...}` | safe | calls `runtime_bundle_manager.repair(...)` |
| `rerun_model_probe` | `{model_path, adapter_dir?}` | safe | re-runs the probe that failed |
| `clear_pip_cache` | `{}` | safe | pip cache purge |

### Dataset

| Action | Args | Trust | Notes |
| --- | --- | --- | --- |
| `validate_dataset` | `{path, expected_format}` | safe | report-only, no mutation |
| `normalize_dataset` | `{path, target_format, output_path?}` | confirm | writes new file unless `--in-place` |
| `inspect_sample` | `{path, n_rows}` | safe | for the model to peek at data |

### Diagnostic / read-only

| Action | Args | Trust | Notes |
| --- | --- | --- | --- |
| `read_log` | `{path, last_n_lines}` | safe | read .log files |
| `probe_hardware` | `{}` | safe | rerun hardware probe |
| `pip_show` | `{name}` | safe | get installed version |
| `python_version` | `{}` | safe | check active python |

### Escape hatches

| Action | Args | Trust | Notes |
| --- | --- | --- | --- |
| `run_shell` | `{cmd, args[], cwd?, timeout_s?}` | danger | only when user has explicitly enabled "advanced supervisor mode" |
| `abort` | `{reason}` | safe | model gives up, surfaces reason to user |
| `ask_user` | `{question, options[]}` | safe | model needs human input (e.g. "this is a CPU-only system, install CPU torch?") |

## Execution result contract

Every tool returns:

```json
{
  "ok": true,
  "exit_code": 0,
  "stdout": "...",
  "stderr": "",
  "elapsed_ms": 4321,
  "side_effects": [
    { "kind": "package_installed", "name": "torch", "version": "2.5.1+cu121" }
  ]
}
```

`side_effects` lets the model and the audit log track what actually changed without re-probing the world.

## Trust tiers — how they work

```
default policy:
  safe    → execute, log, continue
  confirm → emit UI toast "Apply fix: {action} {args}?"
            wait for user click (timeout 30s → treat as deny)
  danger  → refuse; require user to flip "advanced supervisor mode" toggle
```

User can opt into `auto-approve safe + confirm` mode after a few sessions of trusting the supervisor. Stored per-install, not synced.

## Why the surface is this small

Every tool is a *concrete OWLLM-relevant action*. The model doesn't need a general-purpose computer — it needs to install Python packages, swap wheels, repair runtime bundles, and reshape datasets. Keeping the surface narrow:

- Constrains hallucination (can't ask for tools that don't exist).
- Makes auditing tractable (every action is named and logged).
- Lets us evolve the model without touching the executor.
