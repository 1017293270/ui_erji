//! DeepSeek, proxied. The minutes engine runs in the webview and uses `llm_chat` as its
//! `fetch`: it sends an OpenAI-style chat/completions body and gets the raw status and text
//! back, so retries and error handling stay in TypeScript. The request goes through the
//! EchoMind server, which adds the key (server.rs); debug builds can still call DeepSeek
//! directly with the key in .env.local.

use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use tauri::AppHandle;

use crate::{config, server};

const NO_KEY: &str = "还没有配置 DeepSeek：请在 apps/desktop/.env.local 里填写 DEEPSEEK_API_KEY，然后重试。";

/// Minutes for a long meeting can take minutes to generate.
const TIMEOUT: Duration = Duration::from_secs(600);

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        crate::net::public().connect_timeout(Duration::from_secs(15)).timeout(TIMEOUT).build().expect("HTTP client")
    })
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Reply {
    pub(crate) status: u16,
    pub(crate) body: String,
}

async fn chat(base_url: &str, api_key: &str, model: &str, mut body: Value) -> Result<Reply, String> {
    let Some(fields) = body.as_object_mut() else {
        return Err("发给 DeepSeek 的请求格式不对：应该是一个 JSON 对象。".into());
    };
    // Everything the engine sent goes through as is; only a missing model is filled in.
    fields.entry("model").or_insert_with(|| json!(model));
    let response = http()
        .post(format!("{base_url}/chat/completions"))
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| unreachable_message(base_url, &e))?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|e| unreachable_message(base_url, &e))?;
    Ok(Reply { status, body })
}

fn unreachable_message(base_url: &str, error: &reqwest::Error) -> String {
    if error.is_timeout() {
        format!("DeepSeek 在 {} 分钟内没有回复，请稍后再试。", TIMEOUT.as_secs() / 60)
    } else {
        format!("连不上 DeepSeek（{base_url}），请检查网络：{}", crate::error_chain(error))
    }
}

#[tauri::command]
pub async fn llm_status(app: AppHandle) -> Value {
    if config::server_url().is_some() {
        return server::llm_status(&app).await;
    }
    let config = config::deepseek();
    json!({ "configured": config.api_key.is_some(), "model": config.model, "baseUrl": config.base_url, "via": "direct" })
}

#[tauri::command]
pub async fn llm_chat(app: AppHandle, body: Value) -> Result<Reply, String> {
    if config::server_url().is_some() {
        return server::llm_chat(&app, body).await;
    }
    let config = config::deepseek();
    let api_key = config.api_key.ok_or(NO_KEY)?;
    chat(&config.base_url, &api_key, &config.model, body).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Server;

    #[tokio::test]
    async fn adds_the_key_and_passes_the_body_through() {
        let server = Server::start(|_| (429, r#"{"error":{"message":"rate limited"}}"#.to_string())).await;
        let body = json!({ "messages": [{ "role": "user", "content": "你好" }], "max_tokens": 5, "response_format": { "type": "json_object" } });
        let reply = chat(&server.url(), "sk-test", "deepseek-flash", body).await.unwrap();
        assert_eq!(reply, Reply { status: 429, body: r#"{"error":{"message":"rate limited"}}"#.into() });

        let request = server.requests().remove(0);
        assert_eq!(request.method, "POST");
        assert_eq!(request.target, "/chat/completions");
        assert_eq!(request.header("authorization").as_deref(), Some("Bearer sk-test"));
        let sent: Value = serde_json::from_str(&request.body).unwrap();
        assert_eq!(sent["model"], "deepseek-flash");
        assert_eq!(sent["max_tokens"], 5);
        assert_eq!(sent["messages"][0]["content"], "你好");
        assert_eq!(sent["response_format"]["type"], "json_object");
    }

    #[tokio::test]
    async fn keeps_the_engine_model_and_rejects_non_objects() {
        let server = Server::start(|_| (200, "{}".to_string())).await;
        chat(&server.url(), "k", "default", json!({ "model": "deepseek-reasoner" })).await.unwrap();
        let sent: Value = serde_json::from_str(&server.requests()[0].body).unwrap();
        assert_eq!(sent["model"], "deepseek-reasoner");
        assert!(chat(&server.url(), "k", "default", json!([1])).await.is_err());
    }

    #[tokio::test]
    async fn network_failure_is_an_error() {
        let error = chat("http://127.0.0.1:9", "k", "m", json!({})).await.unwrap_err();
        assert!(error.starts_with("连不上 DeepSeek"), "{error}");
    }

    /// Run with `cargo test -- --ignored live_deepseek` to spend a few tokens on the real API.
    #[tokio::test]
    #[ignore]
    async fn live_deepseek() {
        let config = config::deepseek();
        let body = json!({ "messages": [{ "role": "user", "content": "回答一个字：好" }], "max_tokens": 5 });
        let reply = chat(&config.base_url, &config.api_key.expect("DEEPSEEK_API_KEY"), &config.model, body).await.unwrap();
        let parsed: Value = serde_json::from_str(&reply.body).unwrap_or_default();
        println!("status {} model {} finish {}", reply.status, parsed["model"], parsed["choices"][0]["finish_reason"]);
        assert_eq!(reply.status, 200);
    }
}
