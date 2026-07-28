//! Offline document extraction for chat attachments.
//!
//! The UI sends the selected file bytes to this command; nothing leaves the
//! machine.  Keep format handling here so every chat surface and every OS uses
//! the same parser and the same actionable errors.

use base64::Engine as _;
use serde::Serialize;
use std::io::{Cursor, Read};

const MAX_DOCUMENT_BYTES: usize = 32 * 1024 * 1024;
const MAX_EXTRACTED_CHARS: usize = 240_000;

#[derive(Debug, Serialize)]
pub struct DocumentExtraction {
    pub text: String,
    pub format: String,
    pub truncated: bool,
}

fn extension(filename: &str) -> String {
    std::path::Path::new(filename)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn decode_utf_text(bytes: &[u8]) -> Result<String, String> {
    if bytes.starts_with(&[0xff, 0xfe]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16(&units).map_err(|_| "invalid UTF-16 text".into());
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16(&units).map_err(|_| "invalid UTF-16 text".into());
    }
    String::from_utf8(bytes.to_vec())
        .map_err(|_| "text is not valid UTF-8/UTF-16; save it as UTF-8 and attach it again".into())
}

fn decode_xml_entities(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        rest = &rest[pos..];
        let Some(end) = rest.find(';') else {
            out.push_str(rest);
            return out;
        };
        let entity = &rest[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ if entity.starts_with("#x") => u32::from_str_radix(&entity[2..], 16)
                .ok()
                .and_then(char::from_u32),
            _ if entity.starts_with('#') => {
                entity[1..].parse::<u32>().ok().and_then(char::from_u32)
            }
            _ => None,
        };
        if let Some(ch) = decoded {
            out.push(ch);
        } else {
            out.push_str(&rest[..=end]);
        }
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    out
}

fn xml_to_text(xml: &str) -> String {
    let mut out = String::with_capacity(xml.len() / 2);
    let mut in_tag = false;
    let mut tag = String::new();
    for ch in xml.chars() {
        match ch {
            '<' if !in_tag => {
                in_tag = true;
                tag.clear();
            }
            '>' if in_tag => {
                in_tag = false;
                let name = tag
                    .trim()
                    .trim_start_matches('/')
                    .split_whitespace()
                    .next()
                    .unwrap_or("");
                if matches!(
                    name,
                    "w:p" | "text:p" | "text:h" | "a:p" | "row" | "p" | "br"
                ) {
                    out.push('\n');
                } else if matches!(name, "w:tab" | "text:tab" | "tab") {
                    out.push('\t');
                }
            }
            _ if in_tag => tag.push(ch),
            _ => out.push(ch),
        }
    }
    normalize_text(&decode_xml_entities(&out))
}

fn normalize_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut blank_lines = 0usize;
    for raw in input.replace("\r\n", "\n").replace('\r', "\n").lines() {
        let line = raw.trim_end();
        if line.trim().is_empty() {
            blank_lines += 1;
            if blank_lines > 1 {
                continue;
            }
        } else {
            blank_lines = 0;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.trim().to_string()
}

fn extract_zip_xml(bytes: &[u8], ext: &str) -> Result<String, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| format!("corrupt {ext} archive: {e}"))?;
    let mut names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .filter(|name| match ext {
            "docx" => {
                name == "word/document.xml"
                    || name.starts_with("word/header")
                    || name.starts_with("word/footer")
                    || matches!(name.as_str(), "word/footnotes.xml" | "word/endnotes.xml")
            }
            "odt" => name == "content.xml",
            "pptx" => name.starts_with("ppt/slides/slide") && name.ends_with(".xml"),
            "xlsx" => {
                name == "xl/sharedStrings.xml"
                    || (name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml"))
            }
            _ => false,
        })
        .collect();
    names.sort();
    if names.is_empty() {
        return Err(format!(
            "corrupt or unsupported {ext}: document XML is missing"
        ));
    }
    let mut text = String::new();
    for name in names {
        let mut entry = archive
            .by_name(&name)
            .map_err(|e| format!("read {name}: {e}"))?;
        let mut xml = String::new();
        entry
            .read_to_string(&mut xml)
            .map_err(|_| format!("{name} is not valid UTF-8 XML"))?;
        let part = xml_to_text(&xml);
        if !part.is_empty() {
            if !text.is_empty() {
                text.push_str("\n\n");
            }
            text.push_str(&part);
        }
    }
    Ok(text)
}

fn extract_rtf(bytes: &[u8]) -> Result<String, String> {
    let src = String::from_utf8_lossy(bytes);
    if !src.trim_start().starts_with("{\\rtf") {
        return Err("corrupt RTF: missing RTF header".into());
    }
    let chars: Vec<char> = src.chars().collect();
    let mut out = String::new();
    let mut i = 0usize;
    while i < chars.len() {
        match chars[i] {
            '{' | '}' => i += 1,
            '\\' => {
                i += 1;
                if i >= chars.len() {
                    break;
                }
                if chars[i] == '\\' || chars[i] == '{' || chars[i] == '}' {
                    out.push(chars[i]);
                    i += 1;
                    continue;
                }
                if chars[i] == '\'' && i + 2 < chars.len() {
                    let hex: String = chars[i + 1..=i + 2].iter().collect();
                    if let Ok(v) = u8::from_str_radix(&hex, 16) {
                        out.push(v as char);
                    }
                    i += 3;
                    continue;
                }
                let start = i;
                while i < chars.len() && chars[i].is_ascii_alphabetic() {
                    i += 1;
                }
                let word: String = chars[start..i].iter().collect();
                let sign = if i < chars.len() && chars[i] == '-' {
                    i += 1;
                    -1i32
                } else {
                    1
                };
                let num_start = i;
                while i < chars.len() && chars[i].is_ascii_digit() {
                    i += 1;
                }
                let number = if i > num_start {
                    chars[num_start..i]
                        .iter()
                        .collect::<String>()
                        .parse::<i32>()
                        .ok()
                        .map(|n| n * sign)
                } else {
                    None
                };
                if i < chars.len() && chars[i] == ' ' {
                    i += 1;
                }
                match word.as_str() {
                    "par" | "line" => out.push('\n'),
                    "tab" => out.push('\t'),
                    "u" => {
                        if let Some(n) = number {
                            let unit = if n < 0 { (n + 65_536) as u16 } else { n as u16 };
                            if let Some(ch) = char::from_u32(unit as u32) {
                                out.push(ch);
                            }
                            if i < chars.len() && chars[i] == '?' {
                                i += 1;
                            }
                        }
                    }
                    _ => {}
                }
            }
            ch => {
                out.push(ch);
                i += 1;
            }
        }
    }
    Ok(normalize_text(&out))
}

fn collect_binary_runs(bytes: &[u8]) -> String {
    fn push_run(out: &mut Vec<String>, run: &mut String) {
        let clean = run.trim_matches(|c: char| c.is_whitespace() || c == '\0');
        if clean.chars().count() >= 4 && clean.chars().any(char::is_alphabetic) {
            if !out.iter().any(|s| s == clean) {
                out.push(clean.to_string());
            }
        }
        run.clear();
    }
    let mut runs = Vec::new();
    for parity in 0..=1 {
        let mut run = String::new();
        let mut i = parity;
        while i + 1 < bytes.len() {
            let unit = u16::from_le_bytes([bytes[i], bytes[i + 1]]);
            if let Some(ch) = char::from_u32(unit as u32)
                .filter(|c| !c.is_control() || matches!(c, '\n' | '\r' | '\t'))
            {
                if ch.is_alphanumeric() || ch.is_whitespace() || ch.is_ascii_punctuation() {
                    run.push(ch);
                } else {
                    push_run(&mut runs, &mut run);
                }
            } else {
                push_run(&mut runs, &mut run);
            }
            i += 2;
        }
        push_run(&mut runs, &mut run);
    }
    let mut ascii = String::new();
    for &b in bytes {
        let ch = b as char;
        if ch.is_ascii_graphic() || matches!(ch, ' ' | '\n' | '\r' | '\t') {
            ascii.push(ch);
        } else {
            push_run(&mut runs, &mut ascii);
        }
    }
    push_run(&mut runs, &mut ascii);
    normalize_text(&runs.join("\n"))
}

fn extract_legacy_doc(bytes: &[u8]) -> Result<String, String> {
    if !bytes.starts_with(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) {
        return Err("corrupt DOC: missing Microsoft Compound File header".into());
    }
    let text = collect_binary_runs(bytes);
    if text.chars().count() < 4 {
        Err("no readable text found in this legacy DOC; open it in Word/LibreOffice and save as DOCX or PDF".into())
    } else {
        Ok(text)
    }
}

pub fn extract_document_bytes(
    filename: &str,
    mime: &str,
    bytes: &[u8],
) -> Result<DocumentExtraction, String> {
    if bytes.is_empty() {
        return Err("the file is empty".into());
    }
    if bytes.len() > MAX_DOCUMENT_BYTES {
        return Err(format!(
            "document is {:.1} MB; the chat attachment limit is {} MB",
            bytes.len() as f64 / 1_048_576.0,
            MAX_DOCUMENT_BYTES / 1_048_576
        ));
    }
    let ext = extension(filename);
    let format = if !ext.is_empty() {
        ext.clone()
    } else {
        mime.to_ascii_lowercase()
    };
    let text = match ext.as_str() {
        "pdf" => pdf_extract::extract_text_from_mem(bytes).map_err(|e| format!("couldn't read PDF: {e}"))?,
        "docx" | "odt" | "pptx" | "xlsx" => extract_zip_xml(bytes, &ext)?,
        "doc" => extract_legacy_doc(bytes)?,
        "rtf" => extract_rtf(bytes)?,
        "html" | "htm" => xml_to_text(&decode_utf_text(bytes)?),
        "txt" | "text" | "md" | "markdown" | "csv" | "tsv" | "json" | "jsonl"
        | "xml" | "yaml" | "yml" | "log" | "ini" | "cfg" | "toml" | "sql"
        | "py" | "js" | "jsx" | "ts" | "tsx" | "css" | "sh" | "ps1" | "bat" | "cmd" => decode_utf_text(bytes)?,
        _ => return Err(format!("unsupported document type '{}'. Attach PDF, TXT/Markdown, DOC/DOCX, RTF, ODT, HTML, CSV/JSON/XML/YAML, PPTX, or XLSX", if ext.is_empty() { mime } else { &ext })),
    };
    let text = normalize_text(&text);
    if text.is_empty() {
        return Err(format!("no readable text could be extracted from {filename}; it may be corrupt, encrypted, or image-only"));
    }
    let truncated = text.chars().count() > MAX_EXTRACTED_CHARS;
    let text = if truncated {
        text.chars().take(MAX_EXTRACTED_CHARS).collect()
    } else {
        text
    };
    Ok(DocumentExtraction {
        text,
        format,
        truncated,
    })
}

#[tauri::command]
pub async fn document_extract(
    filename: String,
    mime: String,
    data_b64: String,
) -> Result<DocumentExtraction, String> {
    tokio::task::spawn_blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data_b64.as_bytes())
            .map_err(|e| format!("invalid attachment data: {e}"))?;
        extract_document_bytes(&filename, &mime, &bytes)
    })
    .await
    .map_err(|e| format!("document extraction task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zip_with(path: &str, content: &str) -> Vec<u8> {
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut cursor);
            zip.start_file(path, zip::write::FileOptions::default())
                .unwrap();
            zip.write_all(content.as_bytes()).unwrap();
            zip.finish().unwrap();
        }
        cursor.into_inner()
    }

    fn minimal_pdf(text: &str) -> Vec<u8> {
        let stream = format!("BT /F1 12 Tf 72 720 Td ({text}) Tj ET");
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".to_string(),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
            format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()),
        ];
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = vec![0usize];
        for (i, obj) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", i + 1, obj).as_bytes());
        }
        let xref = pdf.len();
        pdf.extend_from_slice(
            format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
        );
        for off in offsets.iter().skip(1) {
            pdf.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
        }
        pdf.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
                objects.len() + 1
            )
            .as_bytes(),
        );
        pdf
    }

    #[test]
    fn extracts_txt_pdf_doc_and_docx() {
        assert!(
            extract_document_bytes("note.txt", "text/plain", b"TXT attachment context")
                .unwrap()
                .text
                .contains("TXT attachment context")
        );

        let pdf = minimal_pdf("PDF attachment context");
        assert!(extract_document_bytes("paper.pdf", "application/pdf", &pdf)
            .unwrap()
            .text
            .contains("PDF attachment context"));

        let docx = zip_with(
            "word/document.xml",
            r#"<w:document><w:body><w:p><w:r><w:t>DOCX attachment context</w:t></w:r></w:p></w:body></w:document>"#,
        );
        assert!(extract_document_bytes(
            "report.docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            &docx
        )
        .unwrap()
        .text
        .contains("DOCX attachment context"));

        let mut doc = vec![0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
        doc.extend(
            "DOC attachment context"
                .encode_utf16()
                .flat_map(u16::to_le_bytes),
        );
        assert!(
            extract_document_bytes("legacy.doc", "application/msword", &doc)
                .unwrap()
                .text
                .contains("DOC attachment context")
        );
    }

    #[test]
    fn corrupt_and_unsupported_documents_fail_clearly() {
        assert!(extract_document_bytes("bad.pdf", "application/pdf", b"not a pdf").is_err());
        let err =
            extract_document_bytes("archive.exe", "application/octet-stream", b"MZ").unwrap_err();
        assert!(err.contains("unsupported document type"));
    }
}
