//! Seal a plaintext with the app's real `support_seal` module and print the
//! armored block on stdout.
//!
//! This exists so the team's Node decryptor is proven against the exact Rust
//! the app ships, rather than against a second implementation of the same
//! scheme (which would only prove the two guesses agree). The gate runs:
//!
//!   cargo run -q --manifest-path src-tauri/seal-harness/Cargo.toml -- <recipient_pub_b64>
//!
//! With no argument it seals to the embedded team key, so a wrong or corrupted
//! `SUPPORT_REPORT_PUBLIC_KEY_B64` fails here instead of in front of a user.

// The module carries constants the app uses and the harness does not.
#[allow(dead_code)]
#[path = "../../src/support_seal.rs"]
mod support_seal;

fn main() {
    let plaintext = std::env::var("SEAL_HARNESS_PLAINTEXT")
        .unwrap_or_else(|_| r#"{"title":"harness","bodyMd":"hello"}"#.to_string());
    let armored = match std::env::args().nth(1) {
        Some(pubkey) => support_seal::seal_to(&pubkey, plaintext.as_bytes()),
        None => support_seal::seal_for_support(plaintext.as_bytes()),
    };
    match armored {
        Ok(block) => println!("{block}"),
        Err(e) => {
            eprintln!("seal failed: {e}");
            std::process::exit(1);
        }
    }
}
