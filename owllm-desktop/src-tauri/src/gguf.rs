// GGUF metadata reader — just enough to size the KV cache correctly.
//
// llama.cpp caps the context window (`-c`) but with `-fit off` (which we MUST
// pass, because its auto-fit crashes on gemma-class models in this tree) it
// won't shrink a too-big window to fit VRAM. So OWLLM has to compute the fit
// itself. The OLD heuristic keyed the window off a coarse VRAM-headroom ladder
// that ASSUMED a full-attention KV cache — which is catastrophically wrong for
// modern models:
//   * Sliding-window attention (Gemma 3/4): 5-of-6 layers only ever hold a
//     ~1K-token window, so their KV cache is ~16x SMALLER than the ladder
//     assumes — a 4B Gemma easily runs 16K context in ~0.5 GB, yet the ladder
//     floored it to 2048 because it saw "<1 GB headroom".
//   * Grouped-query attention: `head_count_kv` < `head_count`, and it can be
//     PER-LAYER (an array in the GGUF), so a flat guess over- or under-shoots.
//
// We read the real geometry from the GGUF header and compute the exact KV-cache
// bytes for a given context — the same arithmetic llama.cpp uses — so we honour
// the user's choice whenever it truly fits and cap it HONESTLY (with the real
// numbers surfaced to them) only when it genuinely won't.
//
// Only the header/metadata region is read (never the weights), so this is fast
// regardless of model size.

use std::fs::File;
use std::io::{self, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

// GGUF metadata value type tags (spec v2/v3).
const T_UINT8: u32 = 0;
const T_INT8: u32 = 1;
const T_UINT16: u32 = 2;
const T_INT16: u32 = 3;
const T_UINT32: u32 = 4;
const T_INT32: u32 = 5;
const T_FLOAT32: u32 = 6;
const T_BOOL: u32 = 7;
const T_STRING: u32 = 8;
const T_ARRAY: u32 = 9;
const T_UINT64: u32 = 10;
const T_INT64: u32 = 11;
const T_FLOAT64: u32 = 12;

/// Attention geometry needed to size the KV cache. All lengths are per-head
/// element counts; `head_count_kv` / `sliding_window_pattern` are per-layer
/// (length 1 when the GGUF stored a scalar — treated as uniform across layers).
#[derive(Debug, Clone)]
pub struct GgufGeom {
    pub arch: String,
    pub block_count: u32,
    /// Trained context ceiling (`n_ctx_train`); never grant more than this.
    pub context_length: Option<u32>,
    pub head_count_kv: Vec<u32>,
    pub key_length: u32,
    pub value_length: u32,
    pub sliding_window: Option<u32>,
    pub key_length_swa: Option<u32>,
    pub value_length_swa: Option<u32>,
    /// Per-layer flag: 1 = sliding-window (SWA) layer, 0 = full/global.
    pub sliding_window_pattern: Vec<u32>,
}

impl GgufGeom {
    fn per_layer_kv_heads(&self, layer: usize) -> u64 {
        if self.head_count_kv.is_empty() {
            return 0;
        }
        // A scalar stored as a 1-element vec applies to every layer.
        let idx = layer % self.head_count_kv.len();
        self.head_count_kv[idx] as u64
    }

    fn layer_is_swa(&self, layer: usize) -> bool {
        if self.sliding_window_pattern.is_empty() || self.sliding_window.is_none() {
            return false;
        }
        let idx = layer % self.sliding_window_pattern.len();
        self.sliding_window_pattern[idx] == 1
    }

    /// Exact KV-cache size (bytes) for `n_ctx` tokens, F16 cache (2 bytes/elem,
    /// llama.cpp's default). Accounts for GQA (per-layer kv heads) and SWA
    /// (sliding layers only hold `min(n_ctx, window)` tokens with their own,
    /// usually smaller, key/value lengths).
    pub fn kv_cache_bytes(&self, n_ctx: u32) -> u64 {
        const ELT: u64 = 2; // F16
        let layers = self.block_count.max(1) as usize;
        let mut total: u64 = 0;
        for layer in 0..layers {
            let hkv = self.per_layer_kv_heads(layer);
            let (klen, vlen, ctx_eff) = if self.layer_is_swa(layer) {
                let win = self.sliding_window.unwrap_or(n_ctx);
                (
                    self.key_length_swa.unwrap_or(self.key_length) as u64,
                    self.value_length_swa.unwrap_or(self.value_length) as u64,
                    n_ctx.min(win) as u64,
                )
            } else {
                (
                    self.key_length as u64,
                    self.value_length as u64,
                    n_ctx as u64,
                )
            };
            total += ctx_eff * hkv * (klen + vlen) * ELT;
        }
        total
    }

    /// Largest context in [512, requested] whose model+KV+reserve fits `budget`.
    /// Returns (granted_ctx, kv_bytes_at_granted). Never exceeds the trained
    /// context. `avail_bytes` is VRAM/unified budget minus the model weights and
    /// the compute reserve, i.e. the room left for the KV cache.
    pub fn fit_context(&self, requested: u32, avail_bytes: u64) -> (u32, u64) {
        let ceiling = self
            .context_length
            .map(|c| requested.min(c))
            .unwrap_or(requested)
            .max(512);
        // Fast path: the ask fits outright.
        if self.kv_cache_bytes(ceiling) <= avail_bytes {
            return (ceiling, self.kv_cache_bytes(ceiling));
        }
        // Binary-search the largest fitting context (KV grows monotonically).
        let (mut lo, mut hi) = (512u32, ceiling);
        while lo < hi {
            let mid = lo + (hi - lo + 1) / 2;
            if self.kv_cache_bytes(mid) <= avail_bytes {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        // Round down to a tidy multiple of 256 for a clean `-c` value.
        let granted = (lo / 256 * 256).max(512);
        (granted, self.kv_cache_bytes(granted))
    }
}

fn read_u32(r: &mut impl Read) -> io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}

fn read_u64(r: &mut impl Read) -> io::Result<u64> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b)?;
    Ok(u64::from_le_bytes(b))
}

fn read_gguf_string(r: &mut impl Read) -> io::Result<String> {
    let len = read_u64(r)? as usize;
    // Guard against a corrupt/huge length blowing up memory.
    if len > 1 << 20 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "string too long",
        ));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Byte width of a fixed-size scalar type, or None for variable/complex types.
fn scalar_width(t: u32) -> Option<u64> {
    match t {
        T_UINT8 | T_INT8 | T_BOOL => Some(1),
        T_UINT16 | T_INT16 => Some(2),
        T_UINT32 | T_INT32 | T_FLOAT32 => Some(4),
        T_UINT64 | T_INT64 | T_FLOAT64 => Some(8),
        _ => None,
    }
}

/// Read a scalar numeric value as u64 (for the integer geometry keys we care
/// about). Returns None for non-numeric types.
fn read_scalar_as_u64<R: Read>(r: &mut R, t: u32) -> io::Result<Option<u64>> {
    let v = match t {
        T_UINT8 | T_INT8 | T_BOOL => {
            let mut b = [0u8; 1];
            r.read_exact(&mut b)?;
            Some(b[0] as u64)
        }
        T_UINT16 | T_INT16 => {
            let mut b = [0u8; 2];
            r.read_exact(&mut b)?;
            Some(u16::from_le_bytes(b) as u64)
        }
        T_UINT32 | T_INT32 => Some(read_u32(r)? as u64),
        T_UINT64 | T_INT64 => Some(read_u64(r)?),
        T_FLOAT32 => {
            let mut b = [0u8; 4];
            r.read_exact(&mut b)?;
            Some(f32::from_le_bytes(b) as u64)
        }
        T_FLOAT64 => {
            let mut b = [0u8; 8];
            r.read_exact(&mut b)?;
            Some(f64::from_le_bytes(b) as u64)
        }
        _ => None,
    };
    Ok(v)
}

/// Skip a value of the given type without allocating (used for keys we ignore,
/// including the huge tokenizer arrays).
fn skip_value<R: Read + Seek>(r: &mut R, t: u32) -> io::Result<()> {
    if let Some(w) = scalar_width(t) {
        r.seek(SeekFrom::Current(w as i64))?;
        return Ok(());
    }
    match t {
        T_STRING => {
            let len = read_u64(r)? as i64;
            r.seek(SeekFrom::Current(len))?;
        }
        T_ARRAY => {
            let elem_t = read_u32(r)?;
            let count = read_u64(r)?;
            if let Some(w) = scalar_width(elem_t) {
                r.seek(SeekFrom::Current((w * count) as i64))?;
            } else if elem_t == T_STRING {
                for _ in 0..count {
                    let len = read_u64(r)? as i64;
                    r.seek(SeekFrom::Current(len))?;
                }
            } else {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "nested/unknown array element type",
                ));
            }
        }
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unknown metadata value type",
            ));
        }
    }
    Ok(())
}

/// Read an array of numeric elements into u64s (bounded — only for the small
/// per-layer geometry arrays, never the vocab). Returns None if non-numeric.
fn read_numeric_array<R: Read + Seek>(r: &mut R) -> io::Result<Option<Vec<u64>>> {
    let elem_t = read_u32(r)?;
    let count = read_u64(r)?;
    let width = match scalar_width(elem_t) {
        Some(w) => w,
        None => {
            // Not numeric — skip its bytes so the stream stays aligned.
            if elem_t == T_STRING {
                for _ in 0..count {
                    let len = read_u64(r)? as i64;
                    r.seek(SeekFrom::Current(len))?;
                }
            }
            return Ok(None);
        }
    };
    // Per-layer arrays are tiny; refuse anything vocab-sized.
    if count > 4096 {
        r.seek(SeekFrom::Current((width * count) as i64))?;
        return Ok(None);
    }
    let mut out = Vec::with_capacity(count as usize);
    for _ in 0..count {
        // read_scalar_as_u64 consumes exactly `width` bytes for numeric types.
        if let Some(v) = read_scalar_as_u64(r, elem_t)? {
            out.push(v);
        }
    }
    Ok(Some(out))
}

/// Parse the GGUF header and extract the attention geometry. Returns None if the
/// file isn't GGUF or the essential keys (block_count / kv heads / key length)
/// are missing — callers fall back to the coarse heuristic in that case.
pub fn read_geometry(path: &Path) -> Option<GgufGeom> {
    let f = File::open(path).ok()?;
    let mut r = BufReader::new(f);

    let mut magic = [0u8; 4];
    r.read_exact(&mut magic).ok()?;
    if &magic != b"GGUF" {
        return None;
    }
    let _version = read_u32(&mut r).ok()?;
    let _tensor_count = read_u64(&mut r).ok()?;
    let kv_count = read_u64(&mut r).ok()?;

    let mut arch: Option<String> = None;
    let mut block_count: Option<u32> = None;
    let mut context_length: Option<u32> = None;
    let mut head_count_kv: Vec<u32> = Vec::new();
    let mut key_length: Option<u32> = None;
    let mut value_length: Option<u32> = None;
    let mut sliding_window: Option<u32> = None;
    let mut key_length_swa: Option<u32> = None;
    let mut value_length_swa: Option<u32> = None;
    let mut swa_pattern: Vec<u32> = Vec::new();

    for _ in 0..kv_count {
        let key = read_gguf_string(&mut r).ok()?;
        let vtype = read_u32(&mut r).ok()?;

        // architecture is the only string we keep; it prefixes the geometry keys.
        if key == "general.architecture" && vtype == T_STRING {
            arch = read_gguf_string(&mut r).ok();
            continue;
        }

        // The geometry keys are `<arch>.<suffix>`; match on the suffix so we
        // don't need the arch resolved first (metadata order isn't guaranteed).
        let suffix = key.split_once('.').map(|(_, s)| s).unwrap_or(key.as_str());
        match suffix {
            "block_count" => {
                block_count = read_scalar_as_u64(&mut r, vtype)
                    .ok()
                    .flatten()
                    .map(|v| v as u32);
            }
            "context_length" => {
                context_length = read_scalar_as_u64(&mut r, vtype)
                    .ok()
                    .flatten()
                    .map(|v| v as u32);
            }
            "attention.head_count_kv" => {
                if vtype == T_ARRAY {
                    if let Some(a) = read_numeric_array(&mut r).ok().flatten() {
                        head_count_kv = a.into_iter().map(|v| v as u32).collect();
                    }
                } else if let Some(v) = read_scalar_as_u64(&mut r, vtype).ok().flatten() {
                    head_count_kv = vec![v as u32];
                }
            }
            "attention.key_length" => {
                key_length = read_scalar_as_u64(&mut r, vtype)
                    .ok()
                    .flatten()
                    .map(|v| v as u32);
            }
            "attention.value_length" => {
                value_length = read_scalar_as_u64(&mut r, vtype)
                    .ok()
                    .flatten()
                    .map(|v| v as u32);
            }
            "attention.sliding_window" => {
                sliding_window = read_scalar_as_u64(&mut r, vtype)
                    .ok()
                    .flatten()
                    .map(|v| v as u32);
            }
            "attention.key_length_swa" => {
                key_length_swa = read_scalar_as_u64(&mut r, vtype)
                    .ok()
                    .flatten()
                    .map(|v| v as u32);
            }
            "attention.value_length_swa" => {
                value_length_swa = read_scalar_as_u64(&mut r, vtype)
                    .ok()
                    .flatten()
                    .map(|v| v as u32);
            }
            "attention.sliding_window_pattern" => {
                if vtype == T_ARRAY {
                    if let Some(a) = read_numeric_array(&mut r).ok().flatten() {
                        swa_pattern = a.into_iter().map(|v| v as u32).collect();
                    }
                } else {
                    // scalar/unknown — skip
                    skip_value(&mut r, vtype).ok()?;
                }
            }
            _ => {
                skip_value(&mut r, vtype).ok()?;
            }
        }
    }

    let block_count = block_count?;
    if block_count == 0 || head_count_kv.is_empty() {
        return None;
    }
    // key_length/value_length can be absent on classic MHA models — derive the
    // conventional head_dim = embedding_length / head_count only if we captured
    // it; otherwise bail to the safe fallback. We keep this simple: require the
    // explicit lengths (present on every GQA/SWA model, which is where the old
    // heuristic hurt). Missing → None → caller uses the coarse ladder.
    let key_length = key_length?;
    let value_length = value_length.unwrap_or(key_length);

    Some(GgufGeom {
        arch: arch.unwrap_or_default(),
        block_count,
        context_length,
        head_count_kv,
        key_length,
        value_length,
        sliding_window,
        key_length_swa,
        value_length_swa,
        sliding_window_pattern: swa_pattern,
    })
}
