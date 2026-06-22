#!/usr/bin/env python3
"""dataset_ingest — extract clean text from documents + URLs for the Dataset
Builder (Phase 1: ingest + extract + chunk; no LLM generation yet).

Self-contained by design: parsing needs NO GPU/torch, so this runs on a plain
host Python (cross-platform), not the heavy WSL training env. Each parser is
import-guarded and degrades gracefully — TXT/MD/DOCX/URL work on the stdlib
alone; only PDF wants an optional lib (pypdf), and a missing lib yields a clear
per-source error rather than crashing the whole run.

Protocol: reads a manifest JSON ({"sources":[{"type":"file"|"url","value":...}],
"chunkSize":N,"chunkOverlap":M}) from --input, writes a result JSON to --output,
and emits one-line JSON progress events on stdout the Rust/UI side streams:
  {"event":"progress","stage":"extract","step":i,"total":n,"detail":"<source>"}
  {"event":"source","value":...,"ok":true,"chars":N,"chunks":N,"error":null}
  {"event":"done","sources":N,"chunks":N,"output":"<path>"}
  {"event":"failed","error":"..."}
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from html.parser import HTMLParser
from typing import Optional


def emit(obj: dict) -> None:
    """One compact JSON line on stdout, flushed — the UI parses these live."""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


# --------------------------------------------------------------------------
# Text extractors — one per source kind. Each returns plain text or raises.
# --------------------------------------------------------------------------
def extract_txt(path: str) -> str:
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def extract_pdf(path: str) -> str:
    try:
        from pypdf import PdfReader  # pure-Python, optional
    except Exception:
        try:
            from PyPDF2 import PdfReader  # legacy name, same API
        except Exception as e:
            raise RuntimeError(
                "PDF support needs the 'pypdf' package "
                "(pip install pypdf). " + str(e)
            )
    reader = PdfReader(path)
    parts = []
    for page in reader.pages:
        try:
            parts.append(page.extract_text() or "")
        except Exception:
            parts.append("")
    return "\n\n".join(parts)


def extract_docx(path: str) -> str:
    # Prefer python-docx, but fall back to the stdlib: a .docx is a zip whose
    # word/document.xml holds the text in <w:t> nodes. This keeps DOCX working
    # with zero third-party deps.
    try:
        import docx  # python-docx

        d = docx.Document(path)
        return "\n".join(p.text for p in d.paragraphs)
    except Exception:
        import re
        import zipfile

        with zipfile.ZipFile(path) as z:
            xml = z.read("word/document.xml").decode("utf-8", "replace")
        # <w:p> = paragraph, <w:t> = text run. Join runs, newline per paragraph.
        paras = re.split(r"</w:p>", xml)
        out = []
        for para in paras:
            runs = re.findall(r"<w:t[^>]*>(.*?)</w:t>", para, flags=re.S)
            if runs:
                text = "".join(runs)
                # Unescape the 5 predefined XML entities.
                for a, b in (("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"),
                             ("&quot;", '"'), ("&apos;", "'")):
                    text = text.replace(a, b)
                out.append(text)
        return "\n".join(out)


class _TextHTMLParser(HTMLParser):
    """Strip tags to readable text; drop script/style; block-ish tags → newline."""

    _SKIP = {"script", "style", "noscript", "head", "svg"}
    _BLOCK = {"p", "br", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6",
              "section", "article", "header", "footer", "ul", "ol", "table"}

    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP:
            self._skip_depth += 1
        elif tag in self._BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self._SKIP and self._skip_depth:
            self._skip_depth -= 1
        elif tag in self._BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if self._skip_depth == 0 and data.strip():
            self.parts.append(data)

    def text(self) -> str:
        import re
        raw = "".join(self.parts)
        # Collapse runs of blank lines + trailing spaces.
        raw = re.sub(r"[ \t]+\n", "\n", raw)
        raw = re.sub(r"\n{3,}", "\n\n", raw)
        return raw.strip()


def extract_url(url: str) -> str:
    # Prefer trafilatura (much cleaner main-content extraction) when present;
    # otherwise stdlib urllib + a tag-stripping HTMLParser (zero deps).
    try:
        import trafilatura
        downloaded = trafilatura.fetch_url(url)
        if downloaded:
            txt = trafilatura.extract(downloaded)
            if txt and txt.strip():
                return txt
    except Exception:
        pass
    import urllib.request

    req = urllib.request.Request(url, headers={"User-Agent": "OwLLM-DatasetBuilder/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        charset = resp.headers.get_content_charset() or "utf-8"
        html = resp.read().decode(charset, "replace")
    p = _TextHTMLParser()
    p.feed(html)
    return p.text()


def extract_one(kind: str, value: str) -> str:
    if kind == "url":
        return extract_url(value)
    if not os.path.isfile(value):
        raise RuntimeError(f"not a file: {value}")
    ext = os.path.splitext(value)[1].lower()
    if ext == ".pdf":
        return extract_pdf(value)
    if ext == ".docx":
        return extract_docx(value)
    if ext in (".txt", ".md", ".markdown", ".text", ""):
        return extract_txt(value)
    # Unknown extension — try plain text; better a best-effort read than refusal.
    return extract_txt(value)


# --------------------------------------------------------------------------
# Chunking — split into coherent passages on paragraph boundaries with overlap.
# --------------------------------------------------------------------------
def chunk_text(text: str, size: int, overlap: int) -> list[str]:
    text = text.strip()
    if not text:
        return []
    if size <= 0:
        return [text]
    paras = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks: list[str] = []
    cur = ""
    for para in paras:
        if cur and len(cur) + len(para) + 2 > size:
            chunks.append(cur)
            # Carry the tail of the current chunk forward as overlap context.
            cur = (cur[-overlap:] if overlap > 0 else "") + "\n\n" + para
        else:
            cur = para if not cur else cur + "\n\n" + para
    if cur.strip():
        chunks.append(cur.strip())
    return chunks


def main() -> int:
    ap = argparse.ArgumentParser(description="Extract + chunk documents/URLs for the Dataset Builder")
    ap.add_argument("--input", required=True, help="Manifest JSON path")
    ap.add_argument("--output", required=True, help="Where to write the result JSON")
    ap.add_argument("--chunk-size", type=int, default=1200)
    ap.add_argument("--chunk-overlap", type=int, default=150)
    args = ap.parse_args()

    try:
        with open(args.input, "r", encoding="utf-8") as f:
            manifest = json.load(f)
    except Exception as e:
        emit({"event": "failed", "error": f"read manifest: {e}"})
        return 1

    sources = manifest.get("sources") or []
    size = int(manifest.get("chunkSize", args.chunk_size))
    overlap = int(manifest.get("chunkOverlap", args.chunk_overlap))
    total = len(sources)
    results = []
    total_chunks = 0

    for i, src in enumerate(sources):
        kind = src.get("type", "file")
        value = src.get("value", "")
        emit({"event": "progress", "stage": "extract", "step": i + 1, "total": total, "detail": value})
        entry: dict = {"type": kind, "value": value, "ok": False, "chars": 0, "chunks": 0, "error": None}
        try:
            # The Rust side pre-extracts PDFs (no 'pypdf' needed — works for
            # everyone) and injects the resulting text, or an error for a
            # scanned/encrypted PDF. Honor those when present; otherwise extract
            # here (TXT/MD/DOCX/URL on the standard library).
            pre_error = src.get("error")
            if pre_error:
                raise RuntimeError(pre_error)
            pre_text = src.get("text")
            text = pre_text if pre_text is not None else extract_one(kind, value)
            chunks = chunk_text(text, size, overlap)
            entry.update(ok=True, chars=len(text), chunks=len(chunks), text=text, chunkList=chunks)
            total_chunks += len(chunks)
        except Exception as e:  # one bad source must not kill the batch
            entry["error"] = str(e)
        emit({"event": "source", "value": value, "ok": entry["ok"],
              "chars": entry["chars"], "chunks": entry["chunks"], "error": entry["error"]})
        results.append(entry)

    try:
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump({"sources": results, "chunkSize": size, "chunkOverlap": overlap,
                       "totalChunks": total_chunks}, f, ensure_ascii=False)
    except Exception as e:
        emit({"event": "failed", "error": f"write output: {e}"})
        return 1

    emit({"event": "done", "sources": total, "chunks": total_chunks, "output": args.output})
    return 0


if __name__ == "__main__":
    sys.exit(main())
