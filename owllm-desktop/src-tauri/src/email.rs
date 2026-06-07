// Email bridge — IMAP receive (poll UNSEEN) + SMTP send.
//
// Unlike the chat bridges there's no webview transport: a browser can't speak
// IMAP/SMTP, so BOTH directions are Rust commands. The JS EmailBridgeRunner
// polls email_poll on an interval and replies via email_send. TLS is
// native-tls, which is schannel on Windows (a system lib — no OpenSSL on the
// build host). Fetching RFC822 marks a message \Seen, so each is processed
// once; use a DEDICATED mailbox for the bot (it will mark inbound mail read).

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailMsg {
    /// Bare sender address, e.g. "alice@example.com".
    pub from: String,
    pub subject: String,
    /// Best-effort plain-text body.
    pub body: String,
    /// RFC Message-ID, for the UI to dedup if needed.
    pub message_id: String,
}

fn header_val(mail: &mailparse::ParsedMail, name: &str) -> String {
    use mailparse::MailHeaderMap;
    mail.headers.get_first_value(name).unwrap_or_default()
}

fn header_addr(mail: &mailparse::ParsedMail, name: &str) -> String {
    let raw = header_val(mail, name);
    // "Alice <alice@example.com>" → "alice@example.com"
    if let (Some(s), Some(e)) = (raw.find('<'), raw.find('>')) {
        if e > s {
            return raw[s + 1..e].trim().to_string();
        }
    }
    raw.trim().to_string()
}

/// Pull the plain-text body out of a (possibly multipart) message.
fn plain_body(mail: &mailparse::ParsedMail) -> String {
    if mail.subparts.is_empty() {
        return mail.get_body().unwrap_or_default();
    }
    for part in &mail.subparts {
        if part.ctype.mimetype == "text/plain" {
            if let Ok(b) = part.get_body() {
                if !b.trim().is_empty() {
                    return b;
                }
            }
        }
        let nested = plain_body(part);
        if !nested.trim().is_empty() {
            return nested;
        }
    }
    mail.get_body().unwrap_or_default()
}

/// Connect over IMAPS, fetch the (newest `max`) UNSEEN messages, parse them.
/// Fetching marks them \Seen so they aren't returned again.
#[tauri::command]
pub async fn email_poll(
    imap_host: String,
    imap_port: u16,
    username: String,
    password: String,
    max: u32,
) -> Result<Vec<EmailMsg>, String> {
    tokio::task::spawn_blocking(move || -> Result<Vec<EmailMsg>, String> {
        let tls = native_tls::TlsConnector::builder()
            .build()
            .map_err(|e| format!("tls: {e}"))?;
        let client = imap::connect((imap_host.as_str(), imap_port), imap_host.as_str(), &tls)
            .map_err(|e| format!("imap connect {imap_host}:{imap_port}: {e}"))?;
        let mut session = client
            .login(&username, &password)
            .map_err(|e| format!("imap login: {}", e.0))?;
        session.select("INBOX").map_err(|e| format!("select INBOX: {e}"))?;
        let unseen = session.search("UNSEEN").map_err(|e| format!("search UNSEEN: {e}"))?;
        let mut seqs: Vec<u32> = unseen.into_iter().collect();
        seqs.sort_unstable();
        if max > 0 && seqs.len() > max as usize {
            seqs = seqs.split_off(seqs.len() - max as usize); // keep newest N
        }
        let mut out = Vec::new();
        for seq in seqs {
            let fetches = match session.fetch(seq.to_string(), "RFC822") {
                Ok(f) => f,
                Err(_) => continue,
            };
            for f in fetches.iter() {
                let raw = match f.body() {
                    Some(b) => b,
                    None => continue,
                };
                if let Ok(parsed) = mailparse::parse_mail(raw) {
                    out.push(EmailMsg {
                        from: header_addr(&parsed, "From"),
                        subject: header_val(&parsed, "Subject"),
                        message_id: header_val(&parsed, "Message-ID"),
                        body: plain_body(&parsed),
                    });
                }
            }
        }
        let _ = session.logout();
        Ok(out)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// Send a reply over SMTP. Port 465 = implicit TLS; anything else = STARTTLS
/// (587 submission is the usual default). `from` defaults to `username`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn email_send(
    smtp_host: String,
    smtp_port: u16,
    username: String,
    password: String,
    from: String,
    to: String,
    subject: String,
    body: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        use lettre::transport::smtp::authentication::Credentials;
        use lettre::{Message, SmtpTransport, Transport};

        let from_addr = if from.trim().is_empty() { username.clone() } else { from };
        let email = Message::builder()
            .from(from_addr.parse().map_err(|e| format!("from address '{from_addr}': {e}"))?)
            .to(to.parse().map_err(|e| format!("to address '{to}': {e}"))?)
            .subject(subject)
            .body(body)
            .map_err(|e| format!("build message: {e}"))?;

        let creds = Credentials::new(username.clone(), password);
        let builder = if smtp_port == 465 {
            SmtpTransport::relay(&smtp_host).map_err(|e| format!("relay {smtp_host}: {e}"))?
        } else {
            SmtpTransport::starttls_relay(&smtp_host).map_err(|e| format!("starttls {smtp_host}: {e}"))?
        };
        let mailer = builder.port(smtp_port).credentials(creds).build();
        mailer.send(&email).map_err(|e| format!("smtp send: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}
