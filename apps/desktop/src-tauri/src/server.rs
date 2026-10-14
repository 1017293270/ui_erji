//! The EchoMind server (apps/server). It holds the Feishu App Secret, people's Feishu tokens and
//! the DeepSeek key, so the app carries no secrets: sign-in still opens the browser and catches
//! Feishu's code on the loopback address (feishu.rs), and the server turns that code into an
//! EchoMind session, kept in server-session.json.
//!
//! Only EchoMind's own CA (certs/echomind-ca.pem) is trusted for the server, so no other
//! certificate, however valid, can stand in for it. The endpoints are in docs/server-phase1.md.

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;
use url::Url;

use crate::feishu::{self, Profile};
use crate::{config, llm, storage};

const CA: &[u8] = include_bytes!("../certs/echomind-ca.pem");
const SIGNED_OUT: &str = "登录已过期，请重新用飞书登录。";

/// Most calls wait on Feishu for a few seconds; minutes for a long meeting can take ten.
const TIMEOUT: Duration = Duration::from_secs(60);
const LLM_TIMEOUT: Duration = Duration::from_secs(660);

fn client(timeout: Duration) -> reqwest::Client {
    let ca = reqwest::Certificate::from_pem(CA).expect("EchoMind CA");
    reqwest::Client::builder()
        .tls_certs_only([ca])
        .connect_timeout(Duration::from_secs(15))
        .timeout(timeout)
        .build()
        .expect("HTTP client")
}

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| client(TIMEOUT))
}

fn llm_http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| client(LLM_TIMEOUT))
}

// ---------------------------------------------------------------------------
// The saved session

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Session {
    token: String,
    profile: Profile,
    #[serde(default)]
    missing_scopes: Vec<String>,
}

fn session_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(storage::data_dir(app)?.join("server-session.json"))
}

fn load(app: &AppHandle) -> Option<Session> {
    serde_json::from_slice(&std::fs::read(session_path(app).ok()?).ok()?).ok()
}

/// Readable by this user only. TODO: move to the Keychain / Credential Manager once builds are signed.
fn save(app: &AppHandle, session: &Session) -> Result<(), String> {
    let text = serde_json::to_vec(session).map_err(|e| e.to_string())?;
    storage::write_private(&session_path(app)?, &text).map_err(|e| format!("保存登录状态失败：{e}"))
}

fn forget(app: &AppHandle) {
    if let Ok(path) = session_path(app) {
        let _ = std::fs::remove_file(path);
    }
}

// ---------------------------------------------------------------------------
// Requests

#[derive(Debug)]
pub(crate) enum Failure {
    /// The server could not be reached.
    Offline(String),
    /// No session, or the server ended it: the person has to sign in again.
    SignedOut(String),
    /// The server answered with an error; `code` is its machine-readable kind.
    Refused { code: String, message: String },
}

impl Failure {
    /// Neither the server nor, behind it, Feishu could be reached: a cache may answer instead.
    pub fn offline(&self) -> bool {
        matches!(self, Failure::Offline(_)) || matches!(self, Failure::Refused { code, .. } if code == "feishu_offline")
    }
}

impl From<Failure> for String {
    fn from(failure: Failure) -> Self {
        match failure {
            Failure::Offline(message) | Failure::SignedOut(message) | Failure::Refused { message, .. } => message,
        }
    }
}

#[derive(Debug)]
struct Reply {
    status: u16,
    /// The body is DeepSeek's own reply, passed through by the server.
    upstream: bool,
    body: String,
}

fn unreachable(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "EchoMind 服务器没有及时回复，请稍后再试。".into()
    } else {
        format!("连不上 EchoMind 服务器，请检查网络：{}", crate::error_chain(error))
    }
}

async fn send(client: &reqwest::Client, base: &str, token: Option<&str>, method: Method, path: &str, query: &[(&str, &str)], body: Option<&Value>) -> Result<Reply, Failure> {
    let mut url = Url::parse(&format!("{base}{path}")).map_err(|e| Failure::Offline(format!("EchoMind 服务器地址不对：{e}")))?;
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query);
    }
    let mut request = client.request(method, url);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request.send().await.map_err(|e| Failure::Offline(unreachable(&e)))?;
    let status = response.status().as_u16();
    let upstream = response.headers().contains_key("x-echomind-upstream");
    let body = response.text().await.map_err(|e| Failure::Offline(unreachable(&e)))?;
    Ok(Reply { status, upstream, body })
}

/// An error reply in words: the server's own sentence when it sent one.
fn refused(reply: &Reply) -> Failure {
    let error: Value = serde_json::from_str(&reply.body).unwrap_or_default();
    let message = error["error"]["message"]
        .as_str()
        .map(String::from)
        .unwrap_or_else(|| format!("EchoMind 服务器出错了（HTTP {}），请稍后再试。", reply.status));
    if reply.status == 401 {
        return Failure::SignedOut(message);
    }
    Failure::Refused { code: error["error"]["code"].as_str().unwrap_or_default().to_string(), message }
}

fn parse(reply: Reply) -> Result<Value, Failure> {
    if !(200..300).contains(&reply.status) || reply.upstream {
        return Err(refused(&reply));
    }
    serde_json::from_str(&reply.body)
        .map_err(|e| Failure::Refused { code: "malformed".into(), message: format!("EchoMind 服务器的回复无法解析：{e}") })
}

fn base() -> Result<String, Failure> {
    config::server_url().ok_or_else(|| Failure::Offline("没有配置 EchoMind 服务器。".into()))
}

/// Calls the server as the signed-in person. A 401 ends the saved session.
pub(crate) async fn call(app: &AppHandle, method: Method, path: &str, query: &[(&str, &str)], body: Option<&Value>) -> Result<Value, Failure> {
    let base = base()?;
    let session = load(app).ok_or_else(|| Failure::SignedOut(SIGNED_OUT.into()))?;
    let result = send(http(), &base, Some(&session.token), method, path, query, body).await.and_then(parse);
    if let Err(Failure::SignedOut(_)) = result {
        forget(app);
    }
    result
}

// ---------------------------------------------------------------------------
// Sign-in

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthConfig {
    app_id: String,
    scopes: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignedIn {
    token: String,
    profile: ServerProfile,
    #[serde(default)]
    missing_scopes: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerProfile {
    name: String,
    en_name: Option<String>,
    open_id: String,
    union_id: Option<String>,
    email: Option<String>,
    tenant_key: Option<String>,
    avatar_url: Option<String>,
}

fn decode<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|e| format!("EchoMind 服务器的回复无法解析：{e}"))
}

/// What the server's session list shows for this computer.
fn device() -> String {
    format!("EchoMind {} · {}", env!("CARGO_PKG_VERSION"), std::env::consts::OS)
}

pub async fn login(app: &AppHandle) -> Result<Profile, String> {
    let base = base()?;
    let config: AuthConfig = decode(send(http(), &base, None, Method::GET, "/v1/auth/feishu/config", &[], None).await.and_then(parse)?)?;
    let (code, verifier) = feishu::authorize(app, &config.app_id, &config.scopes.join(" ")).await?;
    let body = json!({ "code": code, "codeVerifier": verifier, "redirectUri": feishu::redirect_uri(), "device": device() });
    let signed_in: SignedIn = decode(send(http(), &base, None, Method::POST, "/v1/auth/feishu", &[], Some(&body)).await.and_then(parse)?)?;
    let p = signed_in.profile;
    let avatar = match p.avatar_url {
        Some(url) => feishu::avatar_data_url(&url).await,
        None => None,
    };
    let profile = Profile { name: p.name, en_name: p.en_name, open_id: p.open_id, union_id: p.union_id, email: p.email, tenant_key: p.tenant_key, avatar };
    save(app, &Session { token: signed_in.token, profile: profile.clone(), missing_scopes: signed_in.missing_scopes })?;
    crate::show_main(app);
    Ok(profile)
}

/// `feishu_status` with the server: what was saved at sign-in, checked against the server when it answers.
pub async fn status(app: &AppHandle) -> Value {
    let mut session = load(app);
    if session.is_some() {
        match call(app, Method::GET, "/v1/me", &[], None).await {
            // The server can no longer act for this person in Feishu: sign in again.
            Ok(me) if me["feishuSignedIn"].as_bool() == Some(false) => {
                forget(app);
                session = None;
            }
            Ok(me) => {
                if let Some(s) = session.as_mut() {
                    s.missing_scopes = me["missingScopes"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(String::from)).collect();
                    let _ = save(app, s);
                }
            }
            Err(Failure::SignedOut(_)) => session = None,
            // Offline: what was saved last time.
            Err(_) => {}
        }
    }
    json!({
        "configured": true,
        "missingScopes": session.as_ref().map(|s| s.missing_scopes.clone()).unwrap_or_default(),
        "user": session.map(|s| s.profile),
        "redirectUri": feishu::redirect_uri(),
    })
}

pub async fn logout(app: &AppHandle) {
    if load(app).is_some() {
        let _ = call(app, Method::POST, "/v1/auth/logout", &[], None).await;
    }
    forget(app);
}

// ---------------------------------------------------------------------------
// DeepSeek

pub async fn llm_status(app: &AppHandle) -> Value {
    let model = call(app, Method::GET, "/v1/llm/status", &[], None).await.ok().and_then(|v| v["model"].as_str().map(String::from));
    // Unknown while offline or signed out; the server pins the model anyway.
    json!({
        "configured": true,
        "model": model.unwrap_or_else(|| config::deepseek().model),
        "baseUrl": config::server_url().unwrap_or_default(),
        "via": "server",
    })
}

/// DeepSeek's reply as is when the server passed it through; the server's own errors become an `Err`.
pub async fn llm_chat(app: &AppHandle, body: Value) -> Result<llm::Reply, String> {
    let base = base()?;
    let session = load(app).ok_or(SIGNED_OUT)?;
    let reply = send(llm_http(), &base, Some(&session.token), Method::POST, "/v1/llm/chat", &[], Some(&body)).await?;
    if reply.upstream {
        return Ok(llm::Reply { status: reply.status, body: reply.body });
    }
    let failure = refused(&reply);
    if matches!(failure, Failure::SignedOut(_)) {
        forget(app);
    }
    Err(failure.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{Request, Server};

    #[test]
    fn trusts_the_bundled_ca() {
        assert!(reqwest::Certificate::from_pem(CA).is_ok());
        let _ = client(TIMEOUT);
    }

    #[tokio::test]
    async fn sends_the_session_and_reads_replies() {
        let server = Server::start(|r: &Request| match r.path().as_str() {
            "/v1/directory" => (200, r#"[{"id":"ou_a","name":"甲"}]"#.into()),
            "/v1/me" => (401, r#"{"error":{"code":"unauthorized","message":"登录已过期，请重新用飞书登录。"}}"#.into()),
            "/v1/calendar/attendees" => (503, r#"{"error":{"code":"feishu_offline","message":"连不上飞书，请稍后再试：timeout"}}"#.into()),
            _ => (502, "<html>bad gateway</html>".into()),
        })
        .await;
        let reply = send(http(), &server.url(), Some("ems_x"), Method::GET, "/v1/directory", &[("refresh", "1")], None).await.and_then(parse).unwrap();
        assert_eq!(reply[0]["id"], "ou_a");
        let request = &server.requests()[0];
        assert_eq!(request.header("authorization").as_deref(), Some("Bearer ems_x"));
        assert_eq!(request.query("refresh").as_deref(), Some("1"));

        let me = send(http(), &server.url(), Some("ems_x"), Method::GET, "/v1/me", &[], None).await.and_then(parse).unwrap_err();
        assert!(matches!(&me, Failure::SignedOut(m) if m == "登录已过期，请重新用飞书登录。"), "{me:?}");

        let offline = send(http(), &server.url(), None, Method::GET, "/v1/calendar/attendees", &[], None).await.and_then(parse).unwrap_err();
        assert!(offline.offline());
        assert_eq!(String::from(offline), "连不上飞书，请稍后再试：timeout");

        let html = send(http(), &server.url(), None, Method::GET, "/x", &[], None).await.and_then(parse).unwrap_err();
        assert!(!html.offline());
        assert!(String::from(html).contains("HTTP 502"));

        let down = send(http(), "http://127.0.0.1:9", None, Method::GET, "/v1/me", &[], None).await.unwrap_err();
        assert!(down.offline());
        assert!(String::from(down).starts_with("连不上 EchoMind 服务器"));
    }

    #[tokio::test]
    async fn tells_deepseek_replies_from_server_errors() {
        let server = Server::start_with_headers(|r: &Request| {
            if r.body.contains("passthrough") {
                (429, vec![("X-EchoMind-Upstream".into(), "deepseek".into())], r#"{"error":{"message":"rate limited"}}"#.into())
            } else {
                (429, Vec::new(), r#"{"error":{"code":"rate_limited","message":"生成纪要的请求太频繁了，请等一分钟再试。"}}"#.into())
            }
        })
        .await;
        let upstream = send(llm_http(), &server.url(), Some("t"), Method::POST, "/v1/llm/chat", &[], Some(&json!({ "x": "passthrough" }))).await.unwrap();
        assert!(upstream.upstream);
        assert_eq!(upstream.status, 429);
        // DeepSeek's own error is not ours to interpret.
        assert!(parse(upstream).is_err());

        let ours = send(llm_http(), &server.url(), Some("t"), Method::POST, "/v1/llm/chat", &[], Some(&json!({}))).await.unwrap();
        assert!(!ours.upstream);
        assert_eq!(String::from(refused(&ours)), "生成纪要的请求太频繁了，请等一分钟再试。");
    }

    /// `cargo test -- --ignored live_server`: the real server answers through the bundled CA,
    /// and a site with an ordinary public certificate is refused.
    #[tokio::test]
    #[ignore]
    async fn live_server() {
        let health = http().get("https://58.87.77.127:8443/healthz").send().await.expect("server reachable");
        println!("healthz {}", health.status());
        assert!(health.status().is_success());
        let public = http().get("https://open.feishu.cn/").send().await;
        assert!(public.is_err(), "a public certificate must not be trusted for the server");
    }
}
