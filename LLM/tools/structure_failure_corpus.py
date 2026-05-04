"""Stage 2 of the supervisor corpus pipeline.

Reads raw symptom-fix pairs from `bootstrap/recipes/failure_corpus_raw.jsonl`
and produces the structured `{input, output}` JSON schema documented in
LLM/docs/supervisor/FINETUNE.md, ready (after human review) for fine-tuning.

Strategy:
- Each raw row becomes one structured candidate via an LLM call. The LLM
  receives the raw symptom + fix prose, the supervisor system prompt, the
  action catalog, and is constrained to emit a single JSON object matching
  the training schema.
- The LLM also flags "NEEDS_HUMAN" when prose is too vague to map to a
  concrete action -- those rows go into a separate review queue rather than
  polluting the training set.

Backends:
- Claude API (default) -- fast, accurate, requires ANTHROPIC_API_KEY.
- Gemma 4 via llama-server (`--backend gemma`) -- for offline/local pipeline
  once bootstrap ships. Same prompt; cheaper but lower quality at 2B.
- Dry-run heuristic (`--backend stub`) -- emits placeholder rows so the
  rest of the pipeline can be tested without spending tokens.

Usage:
    python LLM/tools/structure_failure_corpus.py                      # claude
    python LLM/tools/structure_failure_corpus.py --backend stub --limit 5
    python LLM/tools/structure_failure_corpus.py --backend gemma --endpoint http://127.0.0.1:8765

Output:
    bootstrap/recipes/failure_corpus_structured.jsonl   # ready-for-review rows
    bootstrap/recipes/failure_corpus_needs_review.jsonl # rows the model flagged
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Protocol

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
RAW_PATH = REPO_ROOT / "LLM" / "bootstrap" / "recipes" / "failure_corpus_raw.jsonl"
OUT_STRUCTURED = REPO_ROOT / "LLM" / "bootstrap" / "recipes" / "failure_corpus_structured.jsonl"
OUT_REVIEW = REPO_ROOT / "LLM" / "bootstrap" / "recipes" / "failure_corpus_needs_review.jsonl"
SYSTEM_PROMPT_PATH = REPO_ROOT / "LLM" / "bootstrap" / "recipes" / "system_prompt.txt"
TOOLS_DOC = REPO_ROOT / "LLM" / "docs" / "supervisor" / "TOOLS.md"


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------


_STRUCTURING_INSTRUCTIONS = """\
You are converting a natural-language bug report into one structured training
example for the OWLLM Supervisor model.

You receive:
- SYMPTOM:  what was failing (often verbose prose from a CHANGELOG entry)
- FIX:      what the developer did to resolve it
- TAGS:     heuristic categories (cuda, deps, training, ...) -- for context only

Your job: emit ONE JSON object with this shape, and nothing else:

{
  "input": {
    "hardware": { ... synthesized realistic hardware spec consistent with the symptom, or {} if irrelevant ... },
    "trigger": { "kind": "<one of: runtime_probe_failed | training_failed | dataset_invalid | install_step_failed | mcp_server_crashed | gpu_oom>", ...payload fields appropriate to the kind... },
    "current_env": { ... realistic versions consistent with the symptom ... },
    "error_log_tail": "<1-15 lines of plausible stderr quoting symbolic identifiers from the symptom>"
  },
  "output": {
    "action": "<one action from the catalog below>",
    "args": { ... },
    "reason": "<one short sentence explaining the choice>",
    "fallback": null | { "action": "...", "args": { ... } }
  }
}

Action catalog (use exactly these names):
  install_pkg, swap_wheel, download_file, install_local_wheel, uninstall_pkg,
  create_venv, set_env, pick_profile, repair_runtime_bundle, rerun_model_probe,
  clear_pip_cache, validate_dataset, normalize_dataset, inspect_sample,
  read_log, probe_hardware, pip_show, python_version, run_shell, abort, ask_user

Rules:
1. The fix in the source describes what *the developer* did to OWLLM source code.
   You are mapping that to what *the supervisor model* should do at *runtime* on
   a *user's machine* when the same failure surfaces. These are different angles --
   if the developer fix was "added CREATE_NO_WINDOW to a subprocess call", the
   user-side supervisor analogue might be repair_runtime_bundle, set_env, or
   ask_user (because the user can't patch our source). If no plausible runtime
   action exists, return:

       {"input": null, "output": null, "needs_review": true,
        "reason": "<why this row doesn't map to a runtime action>"}

2. Versions, paths, and identifiers in the synthesized input MUST be plausible
   and concrete -- never use placeholders like "X" or "TODO". Make them up if
   you have to, but make them realistic.

3. Output strict JSON, no markdown fences, no commentary.
"""


def build_messages(raw: Mapping[str, Any]) -> list[Mapping[str, str]]:
    user_block = (
        f"SYMPTOM:\n{raw.get('symptom','')}\n\n"
        f"FIX:\n{raw.get('fix','')}\n\n"
        f"TAGS: {', '.join(raw.get('tags', []))}"
    )
    return [
        {"role": "system", "content": _STRUCTURING_INSTRUCTIONS},
        {"role": "user", "content": user_block},
    ]


# ---------------------------------------------------------------------------
# Backends
# ---------------------------------------------------------------------------


class StructurerBackend(Protocol):
    name: str
    def generate(self, messages: list[Mapping[str, str]]) -> str: ...


class ClaudeBackend:
    name = "claude"

    def __init__(self, model: str = "claude-haiku-4-5", max_tokens: int = 1024):
        self.model = model
        self.max_tokens = max_tokens
        self._client = None

    def _get_client(self):
        if self._client is None:
            try:
                import anthropic
            except ImportError as e:
                raise RuntimeError("pip install anthropic") from e
            if not os.environ.get("ANTHROPIC_API_KEY"):
                raise RuntimeError("ANTHROPIC_API_KEY not set")
            self._client = anthropic.Anthropic()
        return self._client

    def generate(self, messages: list[Mapping[str, str]]) -> str:
        client = self._get_client()
        system = "\n\n".join(m["content"] for m in messages if m["role"] == "system")
        convo = [{"role": m["role"], "content": m["content"]}
                 for m in messages if m["role"] != "system"]
        resp = client.messages.create(
            model=self.model,
            system=system,
            messages=convo,
            max_tokens=self.max_tokens,
        )
        return resp.content[0].text  # type: ignore[union-attr]


class GemmaBackend:
    """Talk to bundled llama-server with constrained JSON decoding."""
    name = "gemma"

    def __init__(self, endpoint: str = "http://127.0.0.1:8765", max_tokens: int = 1024):
        self.endpoint = endpoint.rstrip("/")
        self.max_tokens = max_tokens

    def generate(self, messages: list[Mapping[str, str]]) -> str:
        try:
            import urllib.request
        except ImportError:
            raise RuntimeError("urllib unavailable")
        prompt = self._format_for_gemma(messages)
        body = json.dumps({
            "prompt": prompt,
            "n_predict": self.max_tokens,
            "temperature": 0.1,
            "stop": ["</s>", "<end_of_turn>"],
        }).encode()
        req = urllib.request.Request(
            f"{self.endpoint}/completion",
            data=body, headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read())
        return data.get("content", "")

    @staticmethod
    def _format_for_gemma(messages: list[Mapping[str, str]]) -> str:
        out = []
        for m in messages:
            if m["role"] == "system":
                out.append(f"<start_of_turn>user\n{m['content']}<end_of_turn>")
            elif m["role"] == "user":
                out.append(f"<start_of_turn>user\n{m['content']}<end_of_turn>")
            elif m["role"] == "assistant":
                out.append(f"<start_of_turn>model\n{m['content']}<end_of_turn>")
        out.append("<start_of_turn>model\n")
        return "\n".join(out)


class StubBackend:
    """No-op backend that returns a deterministic placeholder.

    Lets us test the rest of the pipeline (parsing, splitting, file IO, dedup)
    without spending API tokens.
    """
    name = "stub"

    def generate(self, messages: list[Mapping[str, str]]) -> str:
        return json.dumps({
            "input": None,
            "output": None,
            "needs_review": True,
            "reason": "stub backend -- no real LLM call",
        })


def make_backend(name: str, **kwargs) -> StructurerBackend:
    if name == "claude":
        return ClaudeBackend(**{k: v for k, v in kwargs.items() if k in ("model", "max_tokens")})
    if name == "gemma":
        return GemmaBackend(**{k: v for k, v in kwargs.items() if k in ("endpoint", "max_tokens")})
    if name == "stub":
        return StubBackend()
    raise ValueError(f"unknown backend: {name}")


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


@dataclass
class Stats:
    total: int = 0
    structured: int = 0
    needs_review: int = 0
    failed: int = 0


def parse_response(raw_text: str) -> Mapping[str, Any] | None:
    """Tolerant JSON extraction. Models occasionally wrap output in fences."""
    s = raw_text.strip()
    if s.startswith("```"):
        # strip ```json ... ``` fence
        s = s.split("\n", 1)[1] if "\n" in s else s
        if s.endswith("```"):
            s = s[: -3]
        s = s.strip()
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        # last-ditch: find the first { and matching brace
        start = s.find("{")
        if start < 0:
            return None
        depth = 0
        for i, ch in enumerate(s[start:], start=start):
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(s[start: i + 1])
                    except json.JSONDecodeError:
                        return None
        return None


def is_needs_review(parsed: Mapping[str, Any]) -> bool:
    if parsed.get("needs_review"):
        return True
    if parsed.get("input") is None or parsed.get("output") is None:
        return True
    output = parsed.get("output") or {}
    if not output.get("action"):
        return True
    return False


def iter_raw(path: Path, limit: int | None) -> Iterable[Mapping[str, Any]]:
    n = 0
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            yield row
            n += 1
            if limit and n >= limit:
                break


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--backend", choices=("claude", "gemma", "stub"), default="claude")
    ap.add_argument("--model", default="claude-haiku-4-5", help="claude only")
    ap.add_argument("--endpoint", default="http://127.0.0.1:8765", help="gemma only")
    ap.add_argument("--limit", type=int, default=None, help="cap rows for smoke testing")
    ap.add_argument("--raw", type=Path, default=RAW_PATH)
    ap.add_argument("--out-structured", type=Path, default=OUT_STRUCTURED)
    ap.add_argument("--out-review", type=Path, default=OUT_REVIEW)
    ap.add_argument("--rate-limit-s", type=float, default=0.0,
                    help="sleep between calls (claude rate limit)")
    args = ap.parse_args()

    if not args.raw.exists():
        print(f"raw corpus not found: {args.raw}", file=sys.stderr)
        print("run LLM/tools/build_failure_corpus.py first", file=sys.stderr)
        return 2

    backend = make_backend(args.backend, model=args.model, endpoint=args.endpoint)
    print(f"backend: {backend.name}")

    args.out_structured.parent.mkdir(parents=True, exist_ok=True)
    stats = Stats()

    with args.out_structured.open("w", encoding="utf-8") as fs, \
         args.out_review.open("w", encoding="utf-8") as fr:
        for row in iter_raw(args.raw, args.limit):
            stats.total += 1
            messages = build_messages(row)
            try:
                text = backend.generate(messages)
            except Exception as e:
                stats.failed += 1
                print(f"  [FAIL] {row.get('source','?')}: {e}", file=sys.stderr)
                if args.rate_limit_s:
                    time.sleep(args.rate_limit_s)
                continue

            parsed = parse_response(text)
            if parsed is None:
                stats.failed += 1
                print(f"  [PARSE] {row.get('source','?')}: could not parse JSON", file=sys.stderr)
                if args.rate_limit_s:
                    time.sleep(args.rate_limit_s)
                continue

            envelope = {
                "input": parsed.get("input"),
                "output": parsed.get("output"),
                "meta": {
                    "source": row.get("source"),
                    "tags": row.get("tags", []),
                    "structured_by": backend.name,
                    "verified_human": False,
                    "raw_symptom": row.get("symptom", "")[:500],
                },
            }
            if is_needs_review(parsed):
                envelope["meta"]["needs_review_reason"] = parsed.get("reason", "")
                fr.write(json.dumps(envelope, ensure_ascii=False) + "\n")
                stats.needs_review += 1
            else:
                fs.write(json.dumps(envelope, ensure_ascii=False) + "\n")
                stats.structured += 1

            if args.rate_limit_s:
                time.sleep(args.rate_limit_s)

    print()
    print(f"total       : {stats.total}")
    print(f"structured  : {stats.structured}  -> {args.out_structured.relative_to(REPO_ROOT)}")
    print(f"needs review: {stats.needs_review} -> {args.out_review.relative_to(REPO_ROOT)}")
    print(f"failed      : {stats.failed}")
    print()
    print("next: human review of needs_review rows + spot-check structured rows.")
    print("see LLM/tools/review_failure_corpus.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
