from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional
import json
import os

try:
    from huggingface_hub import snapshot_download, list_models, HfApi
except Exception:  # pragma: no cover
    snapshot_download = None
    list_models = None
    HfApi = None


DEFAULT_BASE_MODELS: List[str] = [
    "unsloth/Qwen2.5-7B-Instruct-bnb-4bit",
    "unsloth/Qwen2.5-14B-Instruct-bnb-4bit",
    "unsloth/Qwen2.5-32B-Instruct-bnb-4bit",
    "unsloth/Mistral-Nemo-Instruct-2407-bnb-4bit",
    "unsloth/OpenHermes-2.5-Mistral-7B-bnb-4bit",
    "unsloth/Phi-3.5-mini-instruct-bnb-4bit",
    "unsloth/Phi-4-bnb-4bit",
    "unsloth/gemma-2-9b-it-bnb-4bit",
    "unsloth/gemma-2-27b-it-bnb-4bit",
]


@dataclass
class HFModelHit:
    model_id: str
    downloads: int | None = None
    likes: int | None = None
    last_modified: str | None = None
    # All Hub tags for this model (library tags like "transformers"/"gguf",
    # quant tags like "awq"/"gptq", task tags, etc.). Populated from the
    # ``ModelInfo.tags`` attribute returned by ``list_models``. The UI uses
    # this to do client-side format filtering, since ``library=transformers``
    # alone still returns repos cross-tagged with GGUF.
    tags: List[str] = None  # type: ignore[assignment]


def get_app_root() -> Path:
    # .../LLM/core/models.py -> .../LLM
    return Path(__file__).resolve().parents[1]


def ensure_dir(p: Path) -> Path:
    p.mkdir(parents=True, exist_ok=True)
    return p


def search_hf_models(
    query: str,
    limit: int = 20,
    libraries: Optional[List[str]] = None,
    tags: Optional[List[str]] = None,
) -> List[HFModelHit]:
    """Search Hugging Face models by free-text query.

    Optional filters narrow the result set on the server side:
      * ``libraries`` — HF library tags (e.g. ``["transformers"]``,
        ``["gguf"]``, ``["peft"]``). Multiple values are OR-combined by
        the Hub.
      * ``tags`` — arbitrary tag filters (e.g. ``["awq"]``, ``["gptq"]``).
    """
    if list_models is None:
        raise RuntimeError("huggingface_hub is not available. Install requirements.txt")
    kwargs: dict = {"search": query, "limit": limit}
    if libraries:
        kwargs["library"] = libraries if len(libraries) > 1 else libraries[0]
    if tags:
        kwargs["filter"] = tags if len(tags) > 1 else tags[0]
    hits: List[HFModelHit] = []
    for m in list_models(**kwargs):
        hits.append(
            HFModelHit(
                model_id=getattr(m, "modelId", None) or getattr(m, "id", ""),
                downloads=getattr(m, "downloads", None),
                likes=getattr(m, "likes", None),
                last_modified=str(getattr(m, "lastModified", None) or ""),
                tags=list(getattr(m, "tags", None) or []),
            )
        )
    return hits


# Substrings that mark a repo as a *derivative* (quantization /
# pre-baked adapter / classifier / safety filter / embedding model)
# rather than a base model the user would pick from a "Recommended
# Models" panel. Matched against the lowercased model_id.
_DERIV_TOKENS: tuple = (
    # Quantization formats — we want the BASE repo, not the GGUF/AWQ
    # mirror. The user can quantize themselves at download time.
    "-gguf", "_gguf", "/gguf", ".gguf",
    "-awq", "_awq", "/awq",
    "-gptq", "_gptq", "/gptq",
    "-bnb-4bit", "-bnb-8bit", "_bnb_4bit", "_bnb_8bit",
    "-int4", "-int8", "-fp8", "-fp4", "-w4a16", "-w8a16",
    "-nvfp4", "_nvfp4", "/nvfp4", "-mxfp4",
    "-1.25bit", "-1bit", "-2bit", "-3bit",
    # Safety / classifier / scorer / embedding / tokenizer style
    # uploads — the panel is for chat/instruct base models.
    "guard", "moderation", "classifier", "scorer", "reward-model",
    "embedding", "embeddings", "-embed", "tokenizer-only",
    "privacy-filter", "/safety-",
    # Diffusion / TTS / image / video — list_models with
    # pipeline_tag=text-generation usually keeps these out, but some
    # leak through on the lastModified path because authors mistag.
    "stable-diffusion", "/sdxl", "/flux", "/wan2", "/ltx",
    "tts-", "-tts", "/whisper", "/parler",
)


def _looks_like_derivative(model_id: str) -> bool:
    """Heuristic: is this repo a quantization / classifier / non-LLM?"""
    if not model_id:
        return True
    mid = model_id.lower()
    return any(tok in mid for tok in _DERIV_TOKENS)


# Orgs whose recent base-model releases are typically what the
# Recommended panel should surface. Membership boosts ranking; it
# is NOT a hard filter (so e.g. a popular community fine-tune still
# qualifies if it has the downloads).
_PREFERRED_ORGS: frozenset = frozenset({
    "google", "meta-llama", "mistralai", "Qwen", "qwen",
    "deepseek-ai", "microsoft", "openai", "openai-community",
    "anthropic", "zai-org", "ai21labs", "01-ai", "01ai",
    "nvidia", "cohereforai", "CohereForAI", "stabilityai",
    "EleutherAI", "tiiuae", "databricks", "internlm", "x-ai",
    "moonshotai", "ibm-granite", "huggingfaceh4", "HuggingFaceH4",
    "smollm", "huggingfacem4", "HuggingFaceTB", "openchat",
    "allenai", "BAAI", "cognitivecomputations", "google-bert",
    "yi-research", "facebook", "bigcode", "WizardLM", "01.AI",
})


def _is_preferred_org(model_id: str) -> bool:
    org = (model_id or "").split("/", 1)[0]
    return org in _PREFERRED_ORGS


def _is_recent(last_modified: str, max_age_days: int = 540) -> bool:
    """True if ``last_modified`` (HF ISO-8601 timestamp) is within
    ``max_age_days`` of now. Used by the Recommended panel to keep
    ancient classics (gpt2, distilgpt2, bert-base) out of the list
    even when their lifetime download counts dwarf newer flagship
    releases. Permissive: anything we can't parse is treated as
    recent (so a malformed timestamp doesn't drop a real release).
    """
    if not last_modified:
        return True
    try:
        from datetime import datetime, timezone, timedelta
        # HF returns "2024-12-15T10:32:11.000Z" or similar; strip the
        # trailing Z so fromisoformat works on Python <3.11.
        s = last_modified.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - dt) <= timedelta(days=max_age_days)
    except Exception:
        return True


def fetch_recent_popular_models(
    min_downloads: int = 5_000,
    limit: int = 20,
    pipeline_tag: str = "text-generation",
    max_age_days: int = 540,
) -> List[HFModelHit]:
    """Fetch up to N text-gen base models for the Recommended panel.

    Strategy (in order — first non-empty wins for the seed list, then
    we merge in the others for breadth):

      0. ``sort=trending_score`` if the installed huggingface_hub
         supports it. This is what the HF website's Trending tab uses
         and matches user expectation ("Gemma 4 / GLM 4.6 / etc. that
         everyone is talking about *right now*").
      1. ``sort=downloads`` — top base models by lifetime downloads.
      2. ``sort=likes`` — top by community endorsement (filters out
         download-bot inflation that's common on quantized mirrors).
      3. ``sort=lastModified`` filtered to ``>= min_downloads``.

    Quality filters applied to every strategy:

      * ``_looks_like_derivative`` drops obvious quantization mirrors
        (-GGUF, -AWQ, -GPTQ, -bnb-4bit, -1.25bit, …), classifier /
        safety / embedding repos, and non-LLM pipelines (TTS, SDXL,
        Whisper) that leak through when authors mistag.
      * Models from ``_PREFERRED_ORGS`` (google, meta-llama,
        deepseek-ai, Qwen, mistralai, microsoft, …) get a ranking
        boost so flagship recent releases surface ahead of niche
        community uploads with similar download counts.

    Resilience: ``list_models`` kwargs have shifted across
    huggingface_hub versions (``pipeline_tag`` vs. ``filter``,
    ``trending_score`` only on newer releases). Each strategy is
    tried with multiple kwarg variants; the first that returns hits
    wins. The download floor auto-relaxes to 10k / 1k / 100 / 0 if
    the strict ``min_downloads`` produces nothing, so a quiet day on
    the Hub still populates the panel instead of dropping to the
    offline fallback. Underlying exceptions are stashed on
    ``fetch_recent_popular_models.last_errors``.
    """
    fetch_recent_popular_models.last_errors = []  # type: ignore[attr-defined]

    if list_models is None:
        raise RuntimeError("huggingface_hub is not available. Install requirements.txt")

    def _to_hit(m) -> HFModelHit:
        return HFModelHit(
            model_id=getattr(m, "modelId", None) or getattr(m, "id", ""),
            downloads=getattr(m, "downloads", None) or 0,
            likes=getattr(m, "likes", None),
            last_modified=str(getattr(m, "lastModified", None) or ""),
            tags=list(getattr(m, "tags", None) or []),
        )

    def _record(stage: str, exc: Exception) -> None:
        fetch_recent_popular_models.last_errors.append(  # type: ignore[attr-defined]
            f"{stage}: {type(exc).__name__}: {exc}"
        )

    def _try_calls(*kw_variants: dict):
        for variant in kw_variants:
            try:
                items = list(list_models(**variant))
            except TypeError as exc:
                _record(f"list_models({variant})", exc)
                continue
            except Exception as exc:
                _record(f"list_models({variant})", exc)
                continue
            if items:
                return items
        return []

    def _variants_for(sort_key: Optional[str], cap: int) -> List[dict]:
        out: List[dict] = []
        base: dict = {"limit": cap}
        if sort_key:
            base["sort"] = sort_key
            base["direction"] = -1
        if pipeline_tag:
            out.append({**base, "pipeline_tag": pipeline_tag})
            out.append({**base, "filter": pipeline_tag})
        out.append(base)
        return out

    fetch_cap = max(limit * 12, 240)

    # Strategy 0: trending_score (newest huggingface_hub only).
    by_trending = [_to_hit(m) for m in _try_calls(*_variants_for("trending_score", fetch_cap))]
    # Strategy 1: lifetime downloads.
    by_downloads = [_to_hit(m) for m in _try_calls(*_variants_for("downloads", fetch_cap))]
    # Strategy 2: community likes.
    by_likes = [_to_hit(m) for m in _try_calls(*_variants_for("likes", fetch_cap))]
    # Strategy 3: lastModified (post-filtered to popular).
    by_recency = [_to_hit(m) for m in _try_calls(*_variants_for("lastModified", fetch_cap))]

    def _quality(h: HFModelHit) -> bool:
        return (
            bool(h.model_id)
            and not _looks_like_derivative(h.model_id)
            and _is_recent(h.last_modified or "", max_age_days)
        )

    def _merge(min_dl: int) -> List[HFModelHit]:
        out: List[HFModelHit] = []
        seen: set[str] = set()
        # Trending first (matches the HF website's Trending tab) with
        # NO download floor — brand-new flagship releases ('gemma-4-…
        # ', 'GLM-4.6') trend before they accumulate 5k downloads.
        # Then likes + downloads + recency for breadth, all with the
        # popularity floor so we don't drown in week-old fine-tunes.
        ordered = (
            [h for h in by_trending if _quality(h)] +
            [h for h in by_likes if _quality(h) and (h.downloads or 0) >= min_dl] +
            [h for h in by_downloads if _quality(h) and (h.downloads or 0) >= min_dl] +
            [h for h in by_recency if _quality(h) and (h.downloads or 0) >= min_dl]
        )
        # Stable sort: preferred orgs first within the merged stream
        # so flagship releases (Google Gemma, Meta Llama, DeepSeek,
        # Qwen, …) win ties against niche community uploads.
        ordered.sort(key=lambda h: 0 if _is_preferred_org(h.model_id) else 1)
        for h in ordered:
            if h.model_id in seen:
                continue
            seen.add(h.model_id)
            out.append(h)
            if len(out) >= limit:
                break
        return out

    # Try the strict floor first, then progressively relax it.
    for floor in (min_downloads, 1000, 100, 0):
        hits = _merge(floor)
        if hits and len(hits) >= max(3, limit // 4):
            if floor != min_downloads:
                fetch_recent_popular_models.last_errors.append(  # type: ignore[attr-defined]
                    f"info: relaxed download floor {min_downloads} -> {floor} "
                    f"to populate panel ({len(hits)} hits)"
                )
            return hits

    # Last resort: drop the recency filter too — better to show
    # popular older models than only 1-2 hits.
    fetch_recent_popular_models.last_errors.append(  # type: ignore[attr-defined]
        f"info: dropped recency filter (max_age_days={max_age_days}) "
        "to populate panel"
    )

    def _quality_no_recency(h: HFModelHit) -> bool:
        return bool(h.model_id) and not _looks_like_derivative(h.model_id)

    out: List[HFModelHit] = []
    seen: set[str] = set()
    fallback_ordered = (
        [h for h in by_trending if _quality_no_recency(h)] +
        [h for h in by_likes if _quality_no_recency(h) and (h.downloads or 0) >= 1000] +
        [h for h in by_downloads if _quality_no_recency(h) and (h.downloads or 0) >= 1000]
    )
    fallback_ordered.sort(key=lambda h: 0 if _is_preferred_org(h.model_id) else 1)
    for h in fallback_ordered:
        if h.model_id in seen:
            continue
        seen.add(h.model_id)
        out.append(h)
        if len(out) >= limit:
            break
    return out


def download_hf_model(model_id: str, target_dir: Path) -> Path:
    """Download a HF model snapshot into target_dir/<model_id_slug>."""
    if snapshot_download is None:
        raise RuntimeError("huggingface_hub is not available. Install requirements.txt")
    target_dir = ensure_dir(target_dir)
    slug = model_id.replace("/", "__")
    dest = ensure_dir(target_dir / slug)
    snapshot_download(
        repo_id=model_id,
        local_dir=str(dest),
        local_dir_use_symlinks=False,
        resume_download=True,
    )
    return dest


def get_model_details(model_id: str, token: Optional[str] = None) -> dict:
    """Fetch detailed model information from Hugging Face API.
    token: optional HF token (else env HF_TOKEN, HUGGINGFACE_HUB_TOKEN, HUGGINGFACEHUB_API_TOKEN, or huggingface_hub get_token).
    """
    if HfApi is None:
        raise RuntimeError("huggingface_hub is not available. Install requirements.txt")
    
    import requests
    import os
    from urllib.parse import quote
    
    if token is None:
        token = (
            os.getenv("HF_TOKEN")
            or os.getenv("HUGGINGFACE_HUB_TOKEN")
            or os.getenv("HUGGINGFACEHUB_API_TOKEN")
        )
        if not token and HfApi is not None:
            try:
                from huggingface_hub import get_token as _get_token
                token = _get_token()
            except Exception:
                pass
    
    # Direct REST call workaround (faster/more reliable than model_info in some cases)
    # Known workaround: call /api/models/{repo_id} with files_metadata=false
    base_url = "https://huggingface.co/api/models/"
    # IMPORTANT: do NOT encode "/" in "org/model". Many servers do not decode "%2F" in paths.
    encoded_id = quote(model_id, safe="/")
    url = f"{base_url}{encoded_id}"
    params = {
        "files_metadata": "false",
    }
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    
    try:
        resp = requests.get(url, params=params, headers=headers, timeout=(3.0, 8.0))
        if resp.status_code in (401, 403):
            raise RuntimeError("Access denied. This model may be gated or require a token.")
        if resp.status_code == 404:
            # Provide a clear, actionable error; this also helps diagnose URL encoding issues.
            raise RuntimeError(f"Model not found on Hugging Face: {model_id}")
        try:
            resp.raise_for_status()
        except requests.exceptions.HTTPError as e:
            snippet = (resp.text or "")[:300]
            raise RuntimeError(f"HF API HTTP {resp.status_code}: {snippet}") from e
        data = resp.json()
    except requests.exceptions.Timeout:
        raise RuntimeError("Request timed out. The Hugging Face API is taking too long to respond.")
    except requests.exceptions.RequestException as e:
        raise RuntimeError(f"Network error: {e}")
    except Exception as e:
        raise RuntimeError(f"Failed to fetch model info: {type(e).__name__}: {e}")
    
    # Extract all available information from JSON
    details = {
        "model_id": data.get("id") or data.get("modelId") or model_id,
        "author": data.get("author"),
        "tags": data.get("tags") or [],
        "pipeline_tag": data.get("pipeline_tag"),
        "library_name": data.get("library_name"),
        "downloads": data.get("downloads"),
        "likes": data.get("likes"),
        "created_at": data.get("createdAt"),
        "last_modified": data.get("lastModified"),
        "private": data.get("private"),
        "gated": data.get("gated"),
        "siblings": [],
        "config": data.get("config"),
        "sha": data.get("sha"),
    }
    
    # Extract file information from siblings if available
    siblings = data.get("siblings") or []
    for s in siblings:
        try:
            details["siblings"].append({
                "filename": s.get("rfilename") or s.get("path"),
                "size": s.get("size"),
            })
        except Exception:
            pass
    
    # Extract card data if available
    card = data.get("cardData") or {}
    details["description"] = card.get("text")  # often empty; we'll fallback to README excerpt
    details["license"] = card.get("license")
    details["thumbnail"] = card.get("thumbnail")
    details["base_model"] = card.get("base_model")
    details["datasets"] = card.get("datasets")
    details["metrics"] = card.get("metrics")
    details["model_type"] = card.get("model_type")

    # Collect thumbnail candidates (model thumbnails are inconsistent; try multiple common paths)
    thumb_candidates: list[str] = []
    if details.get("thumbnail"):
        thumb_candidates.append(str(details["thumbnail"]))
    # Some API responses expose an avatarUrl for the repo
    repo_avatar = data.get("avatarUrl") or data.get("avatar_url")
    if repo_avatar:
        thumb_candidates.append(str(repo_avatar))
    # Common HF thumbnail locations (best-effort)
    thumb_candidates.extend(
        [
            f"https://huggingface.co/{encoded_id}/resolve/main/thumbnail.png",
            f"https://huggingface.co/{encoded_id}/resolve/main/thumbnail.jpg",
            f"https://huggingface.co/{encoded_id}/resolve/main/thumbnail.jpeg",
            f"https://huggingface.co/{encoded_id}/resolve/main/logo.png",
            f"https://huggingface.co/{encoded_id}/resolve/main/logo.jpg",
        ]
    )
    
    # Try to get owner avatar (optional)
    details["avatar_url"] = None
    author = details.get("author")
    if author:
        try:
            user_url = f"https://huggingface.co/api/users/{quote(author, safe='')}"
            user_resp = requests.get(user_url, headers=headers, timeout=(2.0, 4.0))
            if user_resp.ok:
                details["avatar_url"] = user_resp.json().get("avatar_url")
        except Exception:
            pass

    # Add author avatar as a fallback thumbnail
    if details.get("avatar_url"):
        thumb_candidates.append(str(details["avatar_url"]))
    # De-dup while preserving order
    seen = set()
    details["thumbnail_candidates"] = [u for u in thumb_candidates if u and not (u in seen or seen.add(u))]

    # Description fallback: fetch README.md and extract first meaningful paragraph
    if not details.get("description"):
        def _readme_excerpt(md: str, max_chars: int = 700) -> str:
            lines = md.splitlines()
            cleaned: list[str] = []
            for line in lines:
                s = line.strip()
                if not s:
                    if cleaned:
                        break
                    continue
                # skip common badge/header noise
                if s.startswith("[![") or s.startswith("![") or s.startswith("<img") or s.startswith("---"):
                    continue
                if s.startswith("#"):
                    continue
                cleaned.append(s)
            text = " ".join(cleaned).strip()
            if len(text) > max_chars:
                text = text[: max_chars - 3].rstrip() + "..."
            return text

        try:
            # Try main then master
            for rev in ("main", "master"):
                readme_url = f"https://huggingface.co/{encoded_id}/raw/{rev}/README.md"
                r = requests.get(readme_url, headers=headers, timeout=(2.0, 6.0))
                if r.status_code == 200 and r.text:
                    excerpt = _readme_excerpt(r.text)
                    if excerpt:
                        details["description"] = excerpt
                        break
        except Exception:
            pass
    
    return details


def list_local_adapters(adapter_root: Optional[Path] = None) -> List[str]:
    if adapter_root is None:
        adapter_root = get_app_root() / "fine_tuned"
    if not adapter_root.exists():
        return []
    # Only return directories that have adapter files (valid adapters)
    valid_adapters = []
    for p in adapter_root.iterdir():
        if p.is_dir():
            # Check if it's a valid adapter (has adapter_config.json and adapter weights)
            has_config = (p / "adapter_config.json").exists()
            has_weights = (p / "adapter_model.safetensors").exists() or (p / "adapter_model.bin").exists()
            if has_config and has_weights:
                valid_adapters.append(p.name)
    return sorted(valid_adapters)


def list_local_downloads(download_root: Optional[Path] = None) -> List[str]:
    if download_root is None:
        download_root = get_app_root() / "models"
    if not download_root.exists():
        return []
    return sorted([p.name for p in download_root.iterdir() if p.is_dir()])


def detect_model_capabilities(model_id=None, model_name=None, model_path=None):
    """Detect model capabilities (vision, tools, text, reasoning, code) from model ID, name, or config"""
    capabilities = []
    
    # Check model path if provided
    if model_path and os.path.exists(model_path):
        config_path = os.path.join(model_path, "config.json")
        if os.path.exists(config_path):
            try:
                with open(config_path, 'r', encoding='utf-8') as f:
                    config = json.load(f)
                    # Check model_type
                    model_type = config.get("model_type", "").lower()
                    arch = config.get("architectures", [])
                    arch_str = " ".join(arch).lower() if arch else ""
                    
                    # Vision detection
                    if any(keyword in model_type + arch_str for keyword in ["vision", "vl", "multimodal", "clip", "llava"]):
                        capabilities.append("vision")
                    
                    # Tools detection
                    if any(keyword in model_type + arch_str for keyword in ["tool", "function", "agent"]):
                        capabilities.append("tools")
                    
                    # Reasoning detection
                    if any(keyword in model_type + arch_str for keyword in ["reasoning", "r1", "o1", "deepseek", "cot"]):
                        capabilities.append("reasoning")
                    
                    # Code detection
                    if any(keyword in model_type + arch_str for keyword in ["code", "coder", "codegen"]):
                        capabilities.append("code")
            except Exception:
                pass
    
    # Check model ID or name for keywords
    check_str = ""
    if model_id:
        check_str += model_id.lower() + " "
    if model_name:
        check_str += model_name.lower() + " "
    
    # Vision keywords
    if "vision" not in capabilities and any(keyword in check_str for keyword in ["vision", "vl", "multimodal", "llava", "clip"]):
        capabilities.append("vision")
    
    # Tools keywords (enhanced detection for Llama 3.1+, Mistral, Qwen, Phi, Hermes)
    if "tools" not in capabilities:
        has_tools = (
            any(keyword in check_str for keyword in ["tool", "function-calling", "function_calling", "agent", "hermes", "functionary"]) or
            # Llama 3.1+ has native tool support
            ("llama" in check_str and any(version in check_str for version in ["3.1", "3.2", "3.3", "3.4"])) or
            # Mistral models have tool support
            ("mistral" in check_str or "mixtral" in check_str) or
            # Qwen 2+ has tool support
            ("qwen" in check_str and any(version in check_str for version in ["2.", "2-", "2.5"])) or
            # Phi-3+ has tool support
            ("phi" in check_str and any(version in check_str for version in ["3", "4"]))
        )
        if has_tools:
            capabilities.append("tools")
    
    # Reasoning keywords
    if "reasoning" not in capabilities and any(keyword in check_str for keyword in ["reasoning", "r1", "deepseek-r1", "o1", "chain-of-thought", "cot", "-reasoning"]):
        capabilities.append("reasoning")
    
    # Code keywords
    if "code" not in capabilities and any(keyword in check_str for keyword in ["code", "coder", "codegen", "starcoder", "codellama", "wizardcoder", "codeqwen"]):
        capabilities.append("code")
    
    # Default to text if no special capabilities
    if not capabilities:
        capabilities.append("text")
    
    return capabilities


def get_capability_icons(capabilities):
    """Get emoji icons for model capabilities - shows all relevant icons"""
    icons = []
    
    # Always show icons in a consistent order
    if "vision" in capabilities:
        icons.append("👁️")
    if "code" in capabilities:
        icons.append("💻")
    if "tools" in capabilities:
        icons.append("🔧")
    if "reasoning" in capabilities:
        icons.append("🧠")
    
    # If only text capability (no special features), show text icon
    if not icons or (len(capabilities) == 1 and "text" in capabilities):
        icons = ["📝"]
    
    return " ".join(icons)


def get_model_size(model_path):
    """Get model size in human-readable format"""
    if not model_path or not os.path.exists(model_path):
        return "Unknown"
    
    try:
        total_size = 0
        for root, dirs, files in os.walk(model_path):
            for file in files:
                fp = os.path.join(root, file)
                if os.path.exists(fp):
                    total_size += os.path.getsize(fp)
        
        # Convert to GB
        size_gb = total_size / (1024 ** 3)
        if size_gb < 1:
            return f"{total_size / (1024 ** 2):.1f}MB"
        return f"{size_gb:.1f}GB"
    except Exception:
        return "Unknown"


def get_cached_model_stats(model_id: str, ttl_hours: int = 24) -> Optional[dict]:
    """
    Get cached model stats (downloads, likes) from StateStore.
    
    Args:
        model_id: Hugging Face model ID
        ttl_hours: Cache TTL in hours (default 24)
    
    Returns:
        Dict with 'downloads', 'likes', 'fetched_at' if cache is fresh, None otherwise
    """
    from core.state_store import get_state_store
    from datetime import datetime, timedelta
    
    store = get_state_store()
    cache_key = f"hf_stats:{model_id}"
    cached = store.get_kv(cache_key)
    
    if not cached:
        return None
    
    try:
        fetched_at = datetime.fromisoformat(cached.get("fetched_at", ""))
        age = datetime.utcnow() - fetched_at
        if age < timedelta(hours=ttl_hours):
            return cached
    except Exception:
        pass
    
    return None


def set_cached_model_stats(model_id: str, downloads: Optional[int], likes: Optional[int]):
    """
    Cache model stats in StateStore.
    
    Args:
        model_id: Hugging Face model ID
        downloads: Number of downloads (or None)
        likes: Number of likes (or None)
    """
    from core.state_store import get_state_store
    from datetime import datetime
    
    store = get_state_store()
    cache_key = f"hf_stats:{model_id}"
    
    store.set_kv(cache_key, {
        "downloads": downloads,
        "likes": likes,
        "fetched_at": datetime.utcnow().isoformat()
    })


def set_cached_model_stats_ext(model_id: str, downloads: Optional[int], likes: Optional[int],
                              gated: Optional[bool] = None, private: Optional[bool] = None) -> None:
    """Cache model stats including gated/private for token-required UI."""
    from core.state_store import get_state_store
    from datetime import datetime

    store = get_state_store()
    cache_key = f"hf_stats:{model_id}"
    payload = {
        "downloads": downloads,
        "likes": likes,
        "fetched_at": datetime.utcnow().isoformat(),
    }
    if gated is not None:
        payload["gated"] = gated
    if private is not None:
        payload["private"] = private
    store.set_kv(cache_key, payload)


def fetch_model_stats(model_id: str) -> Optional[dict]:
    """
    Fetch model stats from Hugging Face API (downloads, likes).
    Returns None on failure (offline, 404, gated, etc.).
    
    Args:
        model_id: Hugging Face model ID
    
    Returns:
        Dict with 'downloads' and 'likes' (both may be None), or None on error
    """
    try:
        details = get_model_details(model_id)
        downloads = details.get("downloads")
        likes = details.get("likes")
        gated = details.get("gated")
        private = details.get("private")
        set_cached_model_stats_ext(model_id, downloads, likes, gated=gated, private=private)
        return {
            "downloads": downloads,
            "likes": likes,
            "gated": gated,
            "private": private,
        }
    except Exception:
        return None

