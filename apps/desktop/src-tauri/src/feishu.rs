//! 飞书 sign-in and the saved session.
//!
//! Sign-in is OAuth with PKCE: the system browser opens Feishu's consent page and
//! Feishu redirects back to a one-shot listener on 127.0.0.1. The webview only ever
//! sees the profile.
//!
//! With the EchoMind server (the default) only the browser half happens here: the code goes to
//! the server, which holds the App Secret and the tokens (server.rs). Debug builds can still
//! sign in directly with FEISHU_APP_ID / FEISHU_APP_SECRET from .env.local (see config.rs);
//! the API calls made with those tokens live in feishu_api.rs.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex, Notify};
use url::Url;

use crate::config::{self, FeishuApp};
use crate::{server, storage};

const AUTHORIZE: &str = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
/// v2 rather than the newer accounts.feishu.cn/oauth/v3/token: Feishu checks PKCE only on
/// v2 for now, and v3 fails it with 20049. Move once their docs say v3 supports PKCE.
const TOKEN: &str = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
const USER_INFO: &str = "https://open.feishu.cn/open-apis/authen/v1/user_info";
/// Must match the redirect URL registered under 安全设置 in the developer console.
const CALLBACK_PORT: u16 = 43517;
const CALLBACK_PATH: &str = "/feishu/callback";
/// offline_access brings a refresh token, so people stay signed in; the others let EchoMind
/// push todos as the person and read who was invited to a meeting. Name, avatar and open_id
/// come with any user token; the directory is read with the app's own token.
const SCOPES: [&str; 4] = ["offline_access", "task:task:write", "calendar:calendar:read", "calendar:calendar.event:read"];
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

pub(crate) const NOT_CONFIGURED: &str = "还没有配置飞书应用：请在 apps/desktop/.env.local 里填写 FEISHU_APP_ID 和 FEISHU_APP_SECRET。";
const SIGNED_OUT: &str = "还没有登录飞书，或者登录已经过期：请重新用飞书登录。";

#[derive(Default)]
pub struct Feishu {
    /// Refresh tokens work once; two windows refreshing together would sign the user out.
    session: Mutex<()>,
    /// Wakes a sign-in that is still waiting for the browser, so it can give way.
    cancel: Notify,
}

/// What the windows know about the signed-in person.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub(crate) name: String,
    pub(crate) en_name: Option<String>,
    pub(crate) open_id: String,
    pub(crate) union_id: Option<String>,
    pub(crate) email: Option<String>,
    pub(crate) tenant_key: Option<String>,
    /// A data: URL, so the webview needs no access to Feishu's image hosts.
    pub(crate) avatar: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Session {
    access_token: String,
    /// Unix seconds.
    expires_at: u64,
    refresh_token: Option<String>,
    refresh_expires_at: Option<u64>,
    scope: Option<String>,
    profile: Profile,
}

impl Session {
    fn update(&mut self, tokens: Tokens) {
        self.access_token = tokens.access_token;
        self.expires_at = tokens.expires_at;
        self.scope = tokens.scope.or(self.scope.take());
        // A refresh token is single-use: Feishu hands out a new one with every refresh.
        if tokens.refresh_token.is_some() {
            self.refresh_token = tokens.refresh_token;
            self.refresh_expires_at = tokens.refresh_expires_at;
        }
    }
}

struct Tokens {
    access_token: String,
    expires_at: u64,
    refresh_token: Option<String>,
    refresh_expires_at: Option<u64>,
    scope: Option<String>,
}

#[derive(Deserialize)]
struct TokenReply {
    #[serde(default)]
    code: i64,
    access_token: Option<String>,
    expires_in: Option<u64>,
    refresh_token: Option<String>,
    refresh_token_expires_in: Option<u64>,
    scope: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

enum TokenError {
    /// Feishu could not be reached: keep the session, the person may just be offline.
    Network(String),
    /// Feishu said no: the session (or the sign-in attempt) is over.
    Rejected(String),
}

impl From<TokenError> for String {
    fn from(error: TokenError) -> Self {
        match error {
            TokenError::Network(message) | TokenError::Rejected(message) => message,
        }
    }
}

pub(crate) fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default()
}

pub(crate) fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        crate::net::public().timeout(Duration::from_secs(20)).build().expect("HTTP client")
    })
}

fn random(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|e| format!("无法生成随机数：{e}"))?;
    Ok(URL_SAFE_NO_PAD.encode(buf))
}

pub(crate) fn redirect_uri() -> String {
    format!("http://127.0.0.1:{CALLBACK_PORT}{CALLBACK_PATH}")
}

/// Scopes sign-in asks for that a saved session was not granted, e.g. one from before
/// EchoMind pushed todos. An unknown grant counts as missing everything.
fn missing_scopes(granted: Option<&str>) -> Vec<&'static str> {
    let granted: Vec<&str> = granted.unwrap_or_default().split_whitespace().collect();
    SCOPES.into_iter().filter(|scope| !granted.contains(scope)).collect()
}

// ---------------------------------------------------------------------------
// Sign-in

/// The browser half of sign-in: opens Feishu's consent page and waits on the loopback address
/// for the code. Returns the code and the PKCE verifier that goes with it.
pub(crate) async fn authorize(app: &AppHandle, app_id: &str, scopes: &str) -> Result<(String, String), String> {
    let feishu = app.state::<Feishu>();
    feishu.cancel.notify_waiters();
    let listener = bind().await?;

    let redirect = redirect_uri();
    let verifier = random(48)?;
    let state = random(16)?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let url = Url::parse_with_params(
        AUTHORIZE,
        [
            ("client_id", app_id),
            ("response_type", "code"),
            ("redirect_uri", redirect.as_str()),
            ("scope", scopes),
            ("state", state.as_str()),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
        ],
    )
    .map_err(|e| e.to_string())?;
    #[cfg(desktop)]
    crate::open_external(url.as_str()).map_err(|e| format!("无法打开浏览器：{e}"))?;
    #[cfg(mobile)]
    crate::mobile::open_url(app, url.as_str()).await?;

    let code = tokio::select! {
        result = receive_code(listener, state) => result?,
        _ = feishu.cancel.notified() => return Err("已取消飞书登录。".into()),
        _ = tokio::time::sleep(LOGIN_TIMEOUT) => return Err("5 分钟内没有完成飞书授权，请再试一次。".into()),
    };
    Ok((code, verifier))
}

pub async fn login(app: &AppHandle, join_code: Option<String>) -> Result<Profile, String> {
    if config::server_url().is_some() {
        return server::login(app, join_code).await;
    }
    let creds = config::feishu().ok_or(NOT_CONFIGURED)?;
    let (code, verifier) = authorize(app, &creds.app_id, &SCOPES.join(" ")).await?;
    let tokens = request_token(
        &creds,
        json!({ "grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri(), "code_verifier": verifier }),
    )
    .await?;
    let profile = fetch_profile(&tokens.access_token).await?;
    let session = Session {
        access_token: tokens.access_token,
        expires_at: tokens.expires_at,
        refresh_token: tokens.refresh_token,
        refresh_expires_at: tokens.refresh_expires_at,
        scope: tokens.scope,
        profile,
    };
    {
        let feishu = app.state::<Feishu>();
        let _guard = feishu.session.lock().await;
        save(app, &session)?;
    }
    crate::show_main(app);
    Ok(session.profile)
}

/// The port can still be held for a moment by an attempt that was just cancelled.
async fn bind() -> Result<TcpListener, String> {
    let mut tries = 0;
    loop {
        match TcpListener::bind(("127.0.0.1", CALLBACK_PORT)).await {
            Ok(listener) => return Ok(listener),
            Err(_) if tries < 20 => {
                tries += 1;
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(e) => return Err(format!("本机端口 {CALLBACK_PORT} 被占用，收不到飞书的登录结果（{e}）。")),
        }
    }
}

/// Serves the callback until a request with our `state` arrives. Each connection
/// gets its own task: browsers open idle preconnect sockets that never send a request.
async fn receive_code(listener: TcpListener, state: String) -> Result<String, String> {
    let (tx, mut rx) = mpsc::channel::<Result<String, String>>(4);
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue };
                let (tx, state) = (tx.clone(), state.clone());
                tokio::spawn(async move {
                    if let Some(result) = handle_callback(stream, &state).await {
                        let _ = tx.send(result).await;
                    }
                });
            }
            Some(result) = rx.recv() => return result,
        }
    }
}

async fn handle_callback(mut stream: TcpStream, state: &str) -> Option<Result<String, String>> {
    let mut buf = vec![0u8; 8192];
    let mut len = 0;
    while len < buf.len() {
        let read = tokio::time::timeout(Duration::from_secs(30), stream.read(&mut buf[len..])).await;
        match read {
            Ok(Ok(n)) if n > 0 => len += n,
            _ => break,
        }
        if buf[..len].windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    let head = String::from_utf8_lossy(&buf[..len]);
    let target = head.lines().next().and_then(|line| line.split_whitespace().nth(1)).unwrap_or("/");
    let url = Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    if url.path() != CALLBACK_PATH {
        respond(&mut stream, "404 Not Found", "").await;
        return None;
    }
    let query: HashMap<String, String> = url.query_pairs().into_owned().collect();
    if query.get("state").map(String::as_str) != Some(state) {
        // A tab left over from an earlier attempt; keep waiting for the current one.
        respond(&mut stream, "400 Bad Request", &page("这个登录链接已经失效", "请回到 EchoMind，重新点「用飞书登录」。")).await;
        return None;
    }
    if let Some(error) = query.get("error") {
        respond(&mut stream, "200 OK", &page("没有连接飞书", "你取消了授权，可以回到 EchoMind 再试一次。")).await;
        return Some(Err(if error == "access_denied" { "你在飞书页面取消了授权。".into() } else { format!("飞书返回了错误：{error}") }));
    }
    let code = query.get("code")?.clone();
    respond(&mut stream, "200 OK", &page("已连接飞书", "可以关掉这个页面，回到 EchoMind 了。")).await;
    Some(Ok(code))
}

async fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let reply = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(reply.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// The page the browser shows after Feishu sends it back: the app's paper and ink.
fn page(title: &str, text: &str) -> String {
    format!(
        r#"<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EchoMind · {title}</title>
<style>
:root{{color-scheme:light dark;--bg:#faf9f5;--fg:#141413;--muted:#73726c;--clay:#d97757}}
@media (prefers-color-scheme:dark){{:root{{--bg:#262624;--fg:#f0eee6;--muted:#a6a39a}}}}
body{{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.65 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}}
main{{text-align:center;padding:24px 16px 12vh}}
h1{{font:400 30px/1.3 ui-serif,"New York",Georgia,"Songti SC","Microsoft YaHei",serif;margin:20px 0 6px;letter-spacing:-.01em}}
p{{color:var(--muted);margin:0}}
</style></head><body><main>{MARK}<h1>{title}</h1><p>{text}</p></main></body></html>"#
    )
}

/// The EchoMark, as drawn in the app icon.
const MARK: &str = r#"<svg width="64" height="64" viewBox="0 0 48 48" aria-hidden="true" stroke-linecap="round" stroke-linejoin="round"><g transform="rotate(-7 24 24)"><path fill="var(--clay)" d="M14.3 10.1Q26.6 10.6 38.9 11.9Q43.9 12.3 43.5 17.3Q43 23.5 42.4 29.7Q42 34.7 37 34.4Q32.7 34.2 28.4 34Q23.4 33.7 20.4 37.7Q19.1 39.3 18 41Q15.9 43.8 15.5 40.4Q15.4 39.8 15.3 39.2Q14.9 36.3 12 36Q11.7 36 11.3 36Q8.4 35.7 8.5 32.8Q9.1 23.8 9.2 14.7Q9.3 9.7 14.3 10.1Z"/><path fill="none" stroke="var(--fg)" stroke-width="3.4" d="M12.2 8.4Q24 9.2 35.8 9.7Q40.8 10 40.8 15Q40.5 22 40.7 29Q40.6 34 35.6 33.8Q31.5 33.6 27.3 33.5Q22.3 33.3 18.4 36.4Q16.8 37.8 15.1 39.1Q11.6 41.9 13.1 37.6Q13.4 36.7 13.8 35.7Q14.9 32.4 11.5 32.6Q11.1 32.6 10.7 32.6Q7.2 32.8 7.2 29.4Q7.4 21.2 7.2 13.1Q7.2 8.1 12.2 8.4Z"/><path fill="none" stroke="var(--fg)" stroke-width="3" d="M14.7 17.9Q24.8 18.1 34.9 18.7M14.2 24.2Q20.3 24.4 26.4 24.7"/></g></svg>"#;

// ---------------------------------------------------------------------------
// Tokens and profile

async fn request_token(creds: &FeishuApp, mut body: Value) -> Result<Tokens, TokenError> {
    body["client_id"] = json!(creds.app_id);
    body["client_secret"] = json!(creds.app_secret);
    let response = http()
        .post(TOKEN)
        .json(&body)
        .send()
        .await
        .map_err(|e| TokenError::Network(format!("连不上飞书：{e}")))?;
    let reply: TokenReply = response.json().await.map_err(|e| TokenError::Network(format!("飞书的回复无法解析：{e}")))?;
    match reply.access_token {
        Some(access_token) if reply.code == 0 => Ok(Tokens {
            access_token,
            expires_at: now() + reply.expires_in.unwrap_or(7200),
            refresh_token: reply.refresh_token,
            refresh_expires_at: reply.refresh_token_expires_in.map(|s| now() + s),
            scope: reply.scope,
        }),
        _ => Err(TokenError::Rejected(explain(reply.code, reply.error_description.or(reply.error)))),
    }
}

/// The errors someone setting up the app is likely to hit, in words that say what to fix.
fn explain(code: i64, detail: Option<String>) -> String {
    let detail = detail.unwrap_or_default();
    match code {
        20002 => "App Secret 不对：请核对 .env.local 里的 FEISHU_APP_SECRET。".into(),
        20010 => "你不在这个飞书应用的可用范围里：请在开发者后台「版本管理与发布」里把自己加进可用范围，并发布版本。".into(),
        20071 => format!("回调地址不一致：请在飞书开发者后台「安全设置 → 重定向 URL」里添加 {}。", redirect_uri()),
        20003 | 20004 | 20065 => "授权码已过期或用过了，请重新登录。".into(),
        20049 => "飞书的 PKCE 校验没通过，请重新登录；再出现请把这句话发给开发者。".into(),
        _ => format!("飞书登录失败（{code}）：{detail}"),
    }
}

#[derive(Deserialize)]
struct UserInfoReply {
    code: i64,
    msg: Option<String>,
    data: Option<UserInfo>,
}

#[derive(Deserialize)]
struct UserInfo {
    name: String,
    en_name: Option<String>,
    open_id: String,
    union_id: Option<String>,
    email: Option<String>,
    enterprise_email: Option<String>,
    tenant_key: Option<String>,
    avatar_middle: Option<String>,
    avatar_url: Option<String>,
}

async fn fetch_profile(token: &str) -> Result<Profile, String> {
    let reply: UserInfoReply = http()
        .get(USER_INFO)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("连不上飞书：{e}"))?
        .json()
        .await
        .map_err(|e| format!("飞书的回复无法解析：{e}"))?;
    let info = match reply.data {
        Some(info) if reply.code == 0 => info,
        _ => return Err(format!("读取飞书个人信息失败（{}）：{}", reply.code, reply.msg.unwrap_or_default())),
    };
    let avatar = match info.avatar_middle.or(info.avatar_url) {
        Some(url) => avatar_data_url(&url).await,
        None => None,
    };
    let non_empty = |s: Option<String>| s.filter(|s| !s.trim().is_empty());
    Ok(Profile {
        name: info.name,
        en_name: non_empty(info.en_name),
        open_id: info.open_id,
        union_id: non_empty(info.union_id),
        email: non_empty(info.enterprise_email).or(non_empty(info.email)),
        tenant_key: non_empty(info.tenant_key),
        avatar,
    })
}

pub(crate) async fn avatar_data_url(url: &str) -> Option<String> {
    let response = http().get(url).send().await.ok()?.error_for_status().ok()?;
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .filter(|m| m.starts_with("image/"))
        .unwrap_or("image/jpeg")
        .to_string();
    let bytes = response.bytes().await.ok()?;
    (bytes.len() <= 512 * 1024).then(|| format!("data:{mime};base64,{}", STANDARD.encode(&bytes)))
}

// ---------------------------------------------------------------------------
// The saved session

fn session_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(storage::data_dir(app)?.join("feishu-session.json"))
}

fn load(app: &AppHandle) -> Option<Session> {
    let text = std::fs::read(session_path(app).ok()?).ok()?;
    serde_json::from_slice(&text).ok()
}

/// Readable by this user only, and replaced atomically: a torn write would lose the
/// single-use refresh token. TODO: move to the Keychain / Credential Manager once builds are signed.
fn save(app: &AppHandle, session: &Session) -> Result<(), String> {
    let path = session_path(app)?;
    let text = serde_json::to_vec(session).map_err(|e| e.to_string())?;
    storage::write_private(&path, &text).map_err(|e| format!("保存飞书登录状态失败：{e}"))
}

fn forget(app: &AppHandle) {
    if let Ok(path) = session_path(app) {
        let _ = std::fs::remove_file(path);
    }
}

enum Fresh {
    /// The access token is good for at least five more minutes.
    Valid(Session),
    /// Feishu could not be reached to refresh: still signed in, the token may be stale.
    Offline(Session, String),
    SignedOut,
}

/// The saved session, refreshing the access token when less than five minutes are left.
/// Holds the session lock throughout: refresh tokens are single-use.
async fn fresh(app: &AppHandle) -> Fresh {
    let feishu = app.state::<Feishu>();
    let _guard = feishu.session.lock().await;
    let Some(mut session) = load(app) else { return Fresh::SignedOut };
    if session.expires_at > now() + 300 {
        return Fresh::Valid(session);
    }
    let refresh_token = session.refresh_token.clone().filter(|_| session.refresh_expires_at.is_none_or(|t| t > now()));
    let (Some(creds), Some(refresh_token)) = (config::feishu(), refresh_token) else {
        forget(app);
        return Fresh::SignedOut;
    };
    match request_token(&creds, json!({ "grant_type": "refresh_token", "refresh_token": refresh_token })).await {
        Ok(tokens) => {
            session.update(tokens);
            let _ = save(app, &session);
            Fresh::Valid(session)
        }
        Err(TokenError::Network(message)) => Fresh::Offline(session, message),
        Err(TokenError::Rejected(_)) => {
            forget(app);
            Fresh::SignedOut
        }
    }
}

/// A user access token for calling Feishu as the signed-in person.
pub(crate) struct UserToken {
    pub access_token: String,
    pub open_id: String,
}

pub(crate) async fn user_token(app: &AppHandle) -> Result<UserToken, String> {
    let session = match fresh(app).await {
        Fresh::Valid(session) => session,
        Fresh::Offline(session, _) if session.expires_at > now() + 30 => session,
        Fresh::Offline(_, message) => return Err(message),
        Fresh::SignedOut => return Err(SIGNED_OUT.into()),
    };
    Ok(UserToken { access_token: session.access_token, open_id: session.profile.open_id })
}

/// Feishu turned the access token down although it had not expired (revoked, or the app's
/// secret was reset): the next `user_token` refreshes it, or signs out if that fails too.
pub(crate) async fn expire_access_token(app: &AppHandle) {
    let feishu = app.state::<Feishu>();
    let _guard = feishu.session.lock().await;
    if let Some(mut session) = load(app) {
        session.expires_at = 0;
        let _ = save(app, &session);
    }
}

// ---------------------------------------------------------------------------
// Commands

#[tauri::command]
pub async fn feishu_status(app: AppHandle) -> Value {
    if config::server_url().is_some() {
        return server::status(&app).await;
    }
    let session = match fresh(&app).await {
        Fresh::Valid(session) | Fresh::Offline(session, _) => Some(session),
        Fresh::SignedOut => None,
    };
    json!({
        "configured": config::feishu().is_some(),
        "server": false,
        "missingScopes": session.as_ref().map(|s| missing_scopes(s.scope.as_deref())).unwrap_or_default(),
        "user": session.map(|s| s.profile),
        "redirectUri": redirect_uri(),
    })
}

/// `join_code`: the company to sign in to; left out, the one this computer signed in to last.
#[tauri::command]
pub async fn feishu_login(app: AppHandle, join_code: Option<String>) -> Result<Profile, String> {
    login(&app, join_code).await
}

/// Forgets the company, so the next sign-in asks for a join code.
#[tauri::command]
pub fn feishu_forget_company(app: AppHandle) {
    server::forget_company(&app);
}

#[tauri::command]
pub fn feishu_cancel(app: AppHandle) {
    app.state::<Feishu>().cancel.notify_waiters();
}

#[tauri::command]
pub async fn feishu_logout(app: AppHandle) {
    if config::server_url().is_some() {
        return server::logout(&app).await;
    }
    let feishu = app.state::<Feishu>();
    let _guard = feishu.session.lock().await;
    forget(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn get(addr: std::net::SocketAddr, target: &str) -> String {
        let mut stream = TcpStream::connect(addr).await.unwrap();
        stream.write_all(format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes()).await.unwrap();
        let mut reply = String::new();
        stream.read_to_string(&mut reply).await.unwrap();
        reply
    }

    #[tokio::test]
    async fn callback_waits_for_the_matching_state() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let waiting = tokio::spawn(receive_code(listener, "s1".into()));

        // A browser preconnect: opens a socket and never sends anything.
        let _idle = TcpStream::connect(addr).await.unwrap();
        assert!(get(addr, "/favicon.ico").await.starts_with("HTTP/1.1 404"));
        let stale = get(addr, "/feishu/callback?code=old&state=s0").await;
        assert!(stale.starts_with("HTTP/1.1 400") && stale.contains("已经失效"));
        assert!(!waiting.is_finished());

        let ok = get(addr, "/feishu/callback?code=c%2Fx&state=s1").await;
        assert!(ok.starts_with("HTTP/1.1 200") && ok.contains("已连接飞书"));
        assert_eq!(waiting.await.unwrap(), Ok("c/x".to_string()));
    }

    #[tokio::test]
    async fn callback_reports_a_denied_consent() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let waiting = tokio::spawn(receive_code(listener, "s1".into()));
        get(addr, "/feishu/callback?error=access_denied&state=s1").await;
        assert_eq!(waiting.await.unwrap(), Err("你在飞书页面取消了授权。".to_string()));
    }

    #[test]
    fn scopes_missing_from_an_old_session() {
        assert_eq!(missing_scopes(Some("auth:user.id:read offline_access")), ["task:task:write", "calendar:calendar:read", "calendar:calendar.event:read"]);
        assert!(missing_scopes(Some("calendar:calendar.event:read task:task:write offline_access calendar:calendar:read auth:user.id:read")).is_empty());
        assert_eq!(missing_scopes(None).len(), SCOPES.len());
        // A prefix of a scope is not the scope.
        assert!(missing_scopes(Some("offline_access task:task:write calendar:calendar calendar:calendar.event:read")).contains(&"calendar:calendar:read"));
    }

    #[test]
    fn pkce_challenge_matches_rfc_7636() {
        // Appendix B of RFC 7636.
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(b"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"));
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }
}
