use reqwest::Url;

fn base_url() -> String {
    let host = std::env::var("OWLLM_ENGINE_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("OWLLM_ENGINE_PORT").unwrap_or_else(|_| "18765".to_string());
    format!("http://{host}:{port}")
}

pub async fn engine_get(path: &str) -> Result<String, String> {
    let url = Url::parse(&format!("{}{}", base_url(), path)).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {status}: {text}"));
    }
    Ok(text)
}

pub async fn engine_post(path: &str, body: &str) -> Result<String, String> {
    let url = Url::parse(&format!("{}{}", base_url(), path)).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(url)
        .header("content-type", "application/json; charset=utf-8")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {status}: {text}"));
    }
    Ok(text)
}
