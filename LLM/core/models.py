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


def fetch_recent_popular_models(
    min_downloads: int = 10000,
    limit: int = 20,
    pipeline_tag: str = "text-generation",
) -> List[HFModelHit]:
    """Fetch up to N text-gen models that combine "recent" with "popular".

    Two strategies merged:
      1. Most-downloaded text-gen models (sort=downloads).
      2. Most-recently-updated text-gen models (sort=lastModified)
         post-filtered to >= ``min_downloads``.

    Resilience:
      - ``huggingface_hub.list_models`` has had its kwargs renamed across
        versions (``pipeline_tag`` vs. ``filter``, ``direction`` quirks
        on older releases). We try the modern call first, then fall
        back to a parameter set that works on older hub versions, and
        finally to the kwarg-free call. Anything that returns non-empty
        hits wins.
      - The download floor is auto-relaxed to 1000 / 100 / 0 if the
        strict floor produces nothing, so a deserted Hub day or a
        very fresh release wave still populates the panel instead of
        triggering the hardcoded offline fallback.
      - Underlying exceptions are stashed on this function as
        ``fetch_recent_popular_models.last_errors`` so the caller can
        surface them in the Models log instead of failing silently.
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
        """Yield hits from the first kwargs combo that returns >0 items.

        Each variant is tried in turn; the first one that returns hits
        wins. Exceptions are recorded but not raised so the next
        variant gets a chance.
        """
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

    # --- strategy 1: top by downloads ---
    pop_limit = max(limit * 4, 80)
    pop_variants: List[dict] = []
    if pipeline_tag:
        pop_variants.append({"sort": "downloads", "direction": -1,
                             "limit": pop_limit, "pipeline_tag": pipeline_tag})
        # Older huggingface_hub used ``filter`` for pipeline tags.
        pop_variants.append({"sort": "downloads", "direction": -1,
                             "limit": pop_limit, "filter": pipeline_tag})
    pop_variants.append({"sort": "downloads", "direction": -1,
                         "limit": pop_limit})
    pop_variants.append({"limit": pop_limit})
    pop_items = _try_calls(*pop_variants)
    by_downloads = [_to_hit(m) for m in pop_items]

    # --- strategy 2: recency, filtered to popular ones ---
    rec_variants: List[dict] = []
    if pipeline_tag:
        rec_variants.append({"sort": "lastModified", "direction": -1,
                             "limit": 250, "pipeline_tag": pipeline_tag})
        rec_variants.append({"sort": "lastModified", "direction": -1,
                             "limit": 250, "filter": pipeline_tag})
    rec_variants.append({"sort": "lastModified", "direction": -1, "limit": 250})
    rec_items = _try_calls(*rec_variants)
    by_recency = [_to_hit(m) for m in rec_items]

    def _merge(min_dl: int) -> List[HFModelHit]:
        out: List[HFModelHit] = []
        seen: set[str] = set()
        # Recency first (fresh + popular), then downloads for breadth.
        rec_filtered = [h for h in by_recency if (h.downloads or 0) >= min_dl]
        pop_filtered = [h for h in by_downloads if (h.downloads or 0) >= min_dl]
        for h in rec_filtered + pop_filtered:
            if not h.model_id or h.model_id in seen:
                continue
            seen.add(h.model_id)
            out.append(h)
            if len(out) >= limit:
                break
        return out

    # Try the strict floor first, then progressively relax it so a
    # quiet day on the Hub doesn't drop us to the offline fallback.
    for floor in (min_downloads, 1000, 100, 0):
        hits = _merge(floor)
        if hits:
            if floor != min_downloads:
                fetch_recent_popular_models.last_errors.append(  # type: ignore[attr-defined]
                    f"info: relaxed download floor {min_downloads} -> {floor} "
                    f"to populate panel ({len(hits)} hits)"
                )
            return hits

    return []


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

