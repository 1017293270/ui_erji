//! Calls to the Feishu Open Platform: the tenant directory with the app's own token, and the
//! signed-in person's calendar and tasks with their token (see feishu.rs for sign-in).
//! With the EchoMind server (the default) each command asks the server instead, which makes the
//! same calls with the secrets it holds (server.rs); the direct calls below remain for debug
//! builds with ECHOMIND_SERVER_URL=direct.
//!
//! Endpoints, under https://open.feishu.cn/open-apis:
//! - auth/v3/tenant_access_token/internal
//! - contact/v3/departments/:id/children, contact/v3/users/find_by_department
//! - calendar/v4/calendars/primary, …/events/instance_view, …/events/:id/attendees(/:id/chat_members)
//! - task/v2/tasks

use std::collections::{HashMap, HashSet};
use std::future::Future;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;
use url::Url;

use crate::config::{self, FeishuApp};
use crate::feishu::{self, now, UserToken, NOT_CONFIGURED};
use crate::{config::server_url, dates, server, storage};
use reqwest::Method;

const OPEN_API: &str = "https://open.feishu.cn/open-apis";
/// Without `refresh`, a directory younger than this comes from the cache.
const DIRECTORY_MAX_AGE: u64 = 12 * 3600;

#[derive(Default)]
pub struct FeishuApi {
    /// The app's tenant_access_token and when it expires (Unix seconds).
    tenant: Mutex<Option<(String, u64)>>,
    /// One directory walk at a time; the second caller then reads the fresh cache.
    directory: Mutex<()>,
}

// ---------------------------------------------------------------------------
// Errors

#[derive(Debug)]
enum ApiError {
    Network(String),
    /// Feishu answered with a non-zero code. `scopes` are the permissions it said were missing.
    Feishu { code: i64, msg: String, scopes: Vec<String> },
    /// Not a Feishu reply at all: a proxy page, an outage.
    Http(u16),
    /// A successful reply without the field we came for.
    Malformed(&'static str),
}

#[derive(Clone, Copy, PartialEq)]
enum Identity {
    App,
    User,
}

/// A failed call, already put into words for the person.
struct Failed {
    message: String,
    offline: bool,
}

impl From<Failed> for String {
    fn from(failed: Failed) -> Self {
        failed.message
    }
}

impl From<String> for Failed {
    fn from(message: String) -> Self {
        Failed { message, offline: false }
    }
}

impl From<server::Failure> for Failed {
    fn from(failure: server::Failure) -> Self {
        Failed { offline: failure.offline(), message: failure.into() }
    }
}

fn decode<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, Failed> {
    serde_json::from_value(value).map_err(|e| Failed::from(format!("EchoMind 服务器的回复无法解析：{e}")))
}

fn failed(error: ApiError, identity: Identity) -> Failed {
    Failed { offline: matches!(error, ApiError::Network(_)), message: explain(&error, identity) }
}

fn quote_scopes(scopes: &[String]) -> String {
    match scopes {
        [] => "所需的".into(),
        [one] => format!("「{one}」"),
        many => format!("{}中任意一项", many.iter().map(|s| format!("「{s}」")).collect::<String>()),
    }
}

/// The errors people will actually hit, in words that say what to fix.
fn explain(error: &ApiError, identity: Identity) -> String {
    let (code, msg, scopes) = match error {
        ApiError::Network(detail) => return format!("连不上飞书，请检查网络：{detail}"),
        ApiError::Http(status) => return format!("飞书暂时没有正常回复（HTTP {status}），请稍后再试。"),
        ApiError::Malformed(what) => return format!("飞书的回复里没有{what}，请稍后再试。"),
        ApiError::Feishu { code, msg, scopes } => (*code, msg.as_str(), scopes.as_slice()),
    };
    match code {
        99991672 => format!(
            "飞书应用还没有开通{}权限：请在飞书开发者后台「权限管理」里开通，然后在「版本管理与发布」里发布新版本。",
            quote_scopes(scopes)
        ),
        99991679 => format!(
            "你的飞书授权里缺少{}权限：请重新用飞书登录并同意授权。如果授权页里没有这一项，请先在开发者后台开通它并发布新版本。",
            quote_scopes(scopes)
        ),
        99991663 | 99991668 | 99991677 if identity == Identity::User => "飞书登录已经过期：请重新用飞书登录。".into(),
        99991663 | 99991664 | 99991665 => "飞书应用的访问凭证无效，请稍后再试；一直这样请核对 .env.local 里的 FEISHU_APP_ID 和 FEISHU_APP_SECRET。".into(),
        10015 | 99991543 => "App ID 或 App Secret 不对：请核对 .env.local 里的 FEISHU_APP_ID 和 FEISHU_APP_SECRET。".into(),
        10014 | 99991662 | 99991673 => "飞书应用已停用，或者还没有发布到企业里：请在开发者后台检查应用状态，并发布一个版本。".into(),
        20010 => "你不在这个飞书应用的可用范围里：请在开发者后台「版本管理与发布」里把自己加进可用范围，并发布新版本。".into(),
        40004 | 40014 | 41050 => {
            "飞书应用的通讯录权限范围不够：请在开发者后台「权限管理 → 数据权限 → 通讯录权限范围」里选择全部成员，并发布新版本。".into()
        }
        99991400 | 190004 | 190005 | 190010 => "飞书接口调用太频繁了，请稍等一会儿再试。".into(),
        99991401 => "飞书应用开启了 IP 白名单，这台电脑的网络不在名单里：请在开发者后台「安全设置」里调整白名单。".into(),
        191002 => "你没有这个飞书日历的访问权限。".into(),
        194001 => "没有权限查看这个日程的参与人：需要日程组织者允许参与人查看参与人列表。".into(),
        195100 => "这个飞书账号已经离职，或者不在当前企业里：请换一个账号登录。".into(),
        1470400 => format!("飞书任务的内容不符合要求：{msg}"),
        1470403 => format!("没有权限创建这个飞书任务：{msg}"),
        1470500 => "飞书创建任务失败：常见原因是负责人不在本企业或账号已停用。请核对负责人后再试。".into(),
        _ => format!("飞书接口出错（{code}）：{msg}"),
    }
}

/// The scopes a permission error names: `error.permission_violations[].subject`, or the
/// bracketed list in `msg` ("… One of the following scopes is required: [a, b]").
fn violated_scopes(reply: &Value) -> Vec<String> {
    let mut scopes: Vec<String> = reply["error"]["permission_violations"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v["subject"].as_str())
        .map(String::from)
        .collect();
    if scopes.is_empty() {
        let msg = reply["msg"].as_str().unwrap_or_default();
        if let Some((list, _)) = msg.split_once('[').and_then(|(_, rest)| rest.split_once(']')) {
            scopes = list.split(',').map(|s| s.trim().to_string()).filter(|s| s.contains(':')).collect();
        }
    }
    let mut seen = HashSet::new();
    scopes.retain(|s| seen.insert(s.clone()));
    scopes
}

// ---------------------------------------------------------------------------
// HTTP

fn endpoint(base: &str, path: &[&str], query: &[(&str, &str)]) -> Url {
    let mut url = Url::parse(base).expect("API base URL");
    url.path_segments_mut().expect("API base URL").pop_if_empty().extend(path);
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query);
    }
    url
}

/// Sends a request and returns the whole reply when its `code` is 0.
async fn send(request: reqwest::RequestBuilder) -> Result<Value, ApiError> {
    let network = |e: reqwest::Error| ApiError::Network(crate::error_chain(&e));
    let response = request.send().await.map_err(network)?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(network)?;
    let Ok(reply) = serde_json::from_slice::<Value>(&bytes) else { return Err(ApiError::Http(status.as_u16())) };
    match reply["code"].as_i64() {
        Some(0) => Ok(reply),
        Some(code) => Err(ApiError::Feishu { code, msg: reply["msg"].as_str().unwrap_or_default().to_string(), scopes: violated_scopes(&reply) }),
        None => Err(ApiError::Http(status.as_u16())),
    }
}

async fn get(base: &str, token: &str, path: &[&str], query: &[(&str, &str)]) -> Result<Value, ApiError> {
    let mut reply = send(feishu::http().get(endpoint(base, path, query)).bearer_auth(token)).await?;
    Ok(reply["data"].take())
}

/// Every item of a paginated list.
async fn get_all(base: &str, token: &str, path: &[&str], query: &[(&str, &str)]) -> Result<Vec<Value>, ApiError> {
    let mut items = Vec::new();
    let mut page_token = String::new();
    // Bounded, in case a page token ever repeats.
    for _ in 0..1000 {
        let mut data = {
            let mut query = query.to_vec();
            if !page_token.is_empty() {
                query.push(("page_token", &page_token));
            }
            get(base, token, path, &query).await?
        };
        if let Value::Array(page) = data["items"].take() {
            items.extend(page);
        }
        match data["page_token"].as_str() {
            Some(next) if data["has_more"].as_bool() == Some(true) && !next.is_empty() => page_token = next.to_string(),
            _ => break,
        }
    }
    Ok(items)
}

// ---------------------------------------------------------------------------
// Tokens

async fn request_tenant_token(base: &str, creds: &FeishuApp) -> Result<(String, u64), ApiError> {
    let url = endpoint(base, &["auth", "v3", "tenant_access_token", "internal"], &[]);
    let reply = send(feishu::http().post(url).json(&json!({ "app_id": creds.app_id, "app_secret": creds.app_secret }))).await?;
    let token = reply["tenant_access_token"].as_str().filter(|t| !t.is_empty()).ok_or(ApiError::Malformed("应用凭证"))?;
    Ok((token.to_string(), now() + reply["expire"].as_u64().unwrap_or(7200)))
}

/// Runs `op` with the app's tenant_access_token, cached until five minutes before it expires.
/// A token Feishu no longer accepts is replaced once.
async fn as_app<T, F, Fut>(app: &AppHandle, op: F) -> Result<T, Failed>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<T, ApiError>>,
{
    let creds = config::feishu().ok_or_else(|| Failed::from(NOT_CONFIGURED.to_string()))?;
    let state = app.state::<FeishuApi>();
    let mut retried = false;
    loop {
        let token = {
            let mut cached = state.tenant.lock().await;
            match cached.as_ref() {
                Some((token, expires_at)) if *expires_at > now() + 300 => token.clone(),
                _ => {
                    let fresh = request_tenant_token(OPEN_API, &creds).await.map_err(|e| failed(e, Identity::App))?;
                    *cached = Some(fresh.clone());
                    fresh.0
                }
            }
        };
        match op(token).await {
            Err(ApiError::Feishu { code: 99991663 | 99991665, .. }) if !retried => {
                retried = true;
                *state.tenant.lock().await = None;
            }
            result => return result.map_err(|e| failed(e, Identity::App)),
        }
    }
}

/// Runs `op` as the signed-in person. If Feishu turns down a token that had not expired yet,
/// it is refreshed and `op` runs once more (the request was rejected before doing anything).
async fn as_user<T, F, Fut>(app: &AppHandle, op: F) -> Result<T, Failed>
where
    F: Fn(UserToken) -> Fut,
    Fut: Future<Output = Result<T, ApiError>>,
{
    let mut retried = false;
    loop {
        let token = feishu::user_token(app).await?;
        match op(token).await {
            Err(ApiError::Feishu { code: 99991663 | 99991668 | 99991677, .. }) if !retried => {
                retried = true;
                feishu::expire_access_token(app).await;
            }
            result => return result.map_err(|e| failed(e, Identity::User)),
        }
    }
}

// ---------------------------------------------------------------------------
// Directory

/// `Person` in packages/shared/src/meeting.ts.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    id: String,
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    feishu_open_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    department: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    external: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryCache {
    fetched_at: u64,
    people: Vec<Person>,
}

/// An optional scope the app lacks, judged by fields that came back empty for everyone.
#[derive(Debug, PartialEq)]
struct Hint {
    scope: &'static str,
    unlocks: &'static str,
}

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

/// Departments from the walk and `(department the user was listed under, user)` pairs, into
/// people. Fields guarded by scopes the app may not have are left out rather than failing.
fn build_directory(departments: &[Value], members: Vec<(String, Value)>) -> (Vec<Person>, Vec<Hint>) {
    let names: HashMap<&str, String> = departments
        .iter()
        .filter_map(|d| Some((d["open_department_id"].as_str()?, text(&d["name"])?)))
        .collect();
    let mut hints = Vec::new();
    if !departments.is_empty() && names.is_empty() {
        hints.push(Hint { scope: "contact:department.base:readonly", unlocks: "部门名称" });
    }
    if !members.is_empty() && members.iter().all(|(_, user)| user.get("status").is_none()) {
        hints.push(Hint { scope: "contact:user.employee:readonly", unlocks: "职务和在职状态" });
    }

    let mut seen = HashSet::new();
    let mut nameless = false;
    let mut people = Vec::new();
    for (listed_under, user) in members {
        let Some(open_id) = text(&user["open_id"]) else { continue };
        let status = &user["status"];
        if ["is_resigned", "is_exited", "is_frozen"].iter().any(|flag| status[flag].as_bool() == Some(true)) {
            continue;
        }
        let Some(name) = text(&user["name"]) else {
            nameless = true;
            continue;
        };
        if !seen.insert(open_id.clone()) {
            continue;
        }
        // The user's first department when the app may read it, else where the walk found them.
        let department_id = user["department_ids"][0].as_str().unwrap_or(&listed_under);
        let mut aliases: Vec<String> = Vec::new();
        for alias in [text(&user["en_name"]), text(&user["nickname"])].into_iter().flatten() {
            if alias != name && !aliases.contains(&alias) {
                aliases.push(alias);
            }
        }
        people.push(Person {
            id: open_id.clone(),
            name,
            feishu_open_id: Some(open_id),
            department: names.get(department_id).cloned(),
            title: text(&user["job_title"]),
            aliases,
            external: false,
        });
    }
    if nameless {
        hints.push(Hint { scope: "contact:user.base:readonly", unlocks: "成员姓名" });
    }
    (people, hints)
}

/// The departments under the root, for tenants too big for one recursive call (43010).
async fn departments_level_by_level(base: &str, token: &str) -> Result<Vec<Value>, ApiError> {
    let mut all = Vec::new();
    let mut queue = vec!["0".to_string()];
    while let Some(parent) = queue.pop() {
        let query = [("page_size", "50"), ("department_id_type", "open_department_id")];
        let children = get_all(base, token, &["contact", "v3", "departments", &parent, "children"], &query).await?;
        queue.extend(children.iter().filter_map(|d| d["open_department_id"].as_str()).map(String::from));
        all.extend(children);
    }
    Ok(all)
}

/// Walks the org chart from the root department `0` and lists each department's members.
async fn fetch_directory(base: &str, token: &str) -> Result<(Vec<Person>, Vec<Hint>), ApiError> {
    let query = [("fetch_child", "true"), ("page_size", "50"), ("department_id_type", "open_department_id")];
    let departments = match get_all(base, token, &["contact", "v3", "departments", "0", "children"], &query).await {
        Err(ApiError::Feishu { code: 43010, .. }) => departments_level_by_level(base, token).await?,
        result => result?,
    };
    let mut members = Vec::new();
    let ids = std::iter::once("0").chain(departments.iter().filter_map(|d| d["open_department_id"].as_str()));
    for department in ids {
        let query = [("department_id", department), ("department_id_type", "open_department_id"), ("user_id_type", "open_id"), ("page_size", "50")];
        let users = get_all(base, token, &["contact", "v3", "users", "find_by_department"], &query).await?;
        members.extend(users.into_iter().map(|user| (department.to_string(), user)));
    }
    Ok(build_directory(&departments, members))
}

// ---------------------------------------------------------------------------
// Calendar

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Attendees {
    event_title: String,
    attendee_ids: Vec<String>,
}

#[derive(Debug, PartialEq)]
struct Picked {
    event_id: String,
    title: String,
    organizer: Option<String>,
}

fn secs(value: &Value) -> Option<i64> {
    value.as_str()?.parse().ok()
}

/// The event instance overlapping `[start, end)` the most. All-day events (no timestamp) are
/// not meetings; on a tie the shorter, more specific event wins.
fn pick_event(items: &[Value], (start, end): (i64, i64)) -> Option<Picked> {
    items
        .iter()
        .filter(|event| event["status"].as_str() != Some("cancelled"))
        .filter_map(|event| {
            let from = secs(&event["start_time"]["timestamp"])?;
            let to = secs(&event["end_time"]["timestamp"])?;
            let overlap = to.min(end) - from.max(start);
            (overlap > 0).then_some(((overlap, from - to), event))
        })
        .max_by_key(|(rank, _)| *rank)
        .and_then(|(_, event)| {
            Some(Picked {
                event_id: text(&event["event_id"])?,
                title: text(&event["summary"]).unwrap_or_default(),
                organizer: text(&event["event_organizer"]["user_id"]).filter(|id| id.starts_with("ou_")),
            })
        })
}

/// Declined and removed people did not come; the organizer counts either way.
fn attending(attendee: &Value) -> bool {
    attendee["is_external"].as_bool() != Some(true)
        && (attendee["is_organizer"].as_bool() == Some(true) || !matches!(attendee["rsvp_status"].as_str(), Some("decline" | "removed")))
}

async fn event_attendees(base: &str, token: &str, calendar: &str, event: &str) -> Result<Vec<String>, ApiError> {
    let path = ["calendar", "v4", "calendars", calendar, "events", event, "attendees"];
    let query = [("user_id_type", "open_id"), ("page_size", "100")];
    let mut ids = Vec::new();
    for attendee in get_all(base, token, &path, &query).await?.iter().filter(|a| attending(a)) {
        match attendee["type"].as_str() {
            Some("user") => ids.extend(text(&attendee["user_id"])),
            // A group invited as a whole: its members.
            Some("chat") => {
                let Some(attendee_id) = attendee["attendee_id"].as_str() else { continue };
                let path = ["calendar", "v4", "calendars", calendar, "events", event, "attendees", attendee_id, "chat_members"];
                let members = get_all(base, token, &path, &query).await?;
                ids.extend(members.iter().filter(|m| attending(m)).filter_map(|m| text(&m["open_id"])));
            }
            _ => {}
        }
    }
    Ok(ids)
}

async fn meeting_attendees(base: &str, token: &UserToken, window: (i64, i64)) -> Result<Option<Attendees>, ApiError> {
    let access = token.access_token.as_str();
    let url = endpoint(base, &["calendar", "v4", "calendars", "primary"], &[("user_id_type", "open_id")]);
    let primary = send(feishu::http().post(url).bearer_auth(access).json(&json!({}))).await?;
    let calendar = text(&primary["data"]["calendars"][0]["calendar"]["calendar_id"]).ok_or(ApiError::Malformed("主日历"))?;

    // instance_view expands recurring events into their instances in the window.
    let (start, end) = (window.0.to_string(), window.1.to_string());
    let query = [("start_time", start.as_str()), ("end_time", end.as_str()), ("user_id_type", "open_id")];
    let mut data = get(base, access, &["calendar", "v4", "calendars", &calendar, "events", "instance_view"], &query).await?;
    let items = match data["items"].take() {
        Value::Array(items) => items,
        _ => Vec::new(),
    };
    let Some(event) = pick_event(&items, window) else { return Ok(None) };

    // An unmodified instance of a recurring event has an id like `<event>_<start>`; if Feishu
    // does not know that id, the series has the same attendees.
    let attendees = match event_attendees(base, access, &calendar, &event.event_id).await {
        Err(ApiError::Feishu { code: 193000 | 193001, .. }) if event.event_id.contains('_') => {
            let series = event.event_id.rsplit_once('_').map_or(event.event_id.as_str(), |(series, _)| series);
            event_attendees(base, access, &calendar, series).await
        }
        result => result,
    };
    let mut ids = match attendees {
        Ok(ids) => ids,
        // The organizer hid the guest list: the organizer and the person recording still count.
        Err(ApiError::Feishu { code: 194001, .. }) => Vec::new(),
        Err(error) => return Err(error),
    };
    ids.extend(event.organizer);
    ids.push(token.open_id.clone());
    let mut seen = HashSet::new();
    ids.retain(|id| seen.insert(id.clone()));
    Ok(Some(Attendees { event_title: event.title, attendee_ids: ids }))
}

fn meeting_window(start: &str, end: &str) -> Result<(i64, i64), String> {
    let parse = |s: &str| dates::parse_iso_secs(s).ok_or_else(|| format!("会议时间「{s}」不是 ISO 8601 格式。"));
    let (start, end) = (parse(start)?, parse(end)?);
    if end < start {
        return Err("会议的结束时间早于开始时间。".into());
    }
    // Feishu caps the window at 40 days; no meeting comes close.
    if end - start > 7 * 86_400 {
        return Err("会议时间跨度超过 7 天，找不到对应的日程。".into());
    }
    // A zero-length window overlaps nothing.
    Ok((start, end.max(start + 60)))
}

// ---------------------------------------------------------------------------
// Tasks

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTask {
    title: String,
    description: Option<String>,
    /// YYYY-MM-DD.
    due: Option<String>,
    assignee_id: String,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
pub struct CreatedTask {
    guid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
}

/// Feishu keeps only the UTC day of an all-day timestamp and shows that day in every time zone.
/// So 2026-10-20 is sent as 2026-10-20T00:00Z: Beijing midnight (16:00 UTC the day before)
/// would show up as the 19th.
fn all_day_timestamp(date: &str) -> Option<String> {
    let (year, month, day) = dates::parse_date(date)?;
    Some((dates::days_from_civil(year, month, day) * 86_400_000).to_string())
}

/// Feishu allows 3000 characters for both the title and the description.
fn clip(s: &str) -> String {
    s.chars().take(3000).collect()
}

fn task_body(task: &NewTask) -> Result<Value, String> {
    let title = task.title.trim();
    if title.is_empty() {
        return Err("这条待办没有标题，不能推送到飞书。".into());
    }
    let assignee = task.assignee_id.trim();
    if !assignee.starts_with("ou_") {
        return Err("这条待办的负责人不在飞书通讯录里，不能推送到飞书任务。".into());
    }
    let mut body = json!({
        "summary": clip(title),
        "members": [{ "id": assignee, "type": "user", "role": "assignee" }],
        "origin": { "platform_i18n_name": { "zh_cn": "EchoMind 会议纪要", "en_us": "EchoMind" } },
    });
    if let Some(description) = task.description.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        body["description"] = json!(clip(description));
    }
    if let Some(due) = task.due.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        let timestamp = all_day_timestamp(due).ok_or_else(|| format!("截止日期「{due}」不是 YYYY-MM-DD 格式的日期。"))?;
        body["due"] = json!({ "timestamp": timestamp, "is_all_day": true });
    }
    Ok(body)
}

async fn create_task(base: &str, token: &str, body: &Value) -> Result<CreatedTask, ApiError> {
    let url = endpoint(base, &["task", "v2", "tasks"], &[("user_id_type", "open_id")]);
    let reply = send(feishu::http().post(url).bearer_auth(token).json(body)).await?;
    let task = &reply["data"]["task"];
    Ok(CreatedTask { guid: text(&task["guid"]).ok_or(ApiError::Malformed("任务 ID"))?, url: text(&task["url"]) })
}

// ---------------------------------------------------------------------------
// Commands

/// Everyone in the tenant. Without `refresh` a recent cache answers; when Feishu cannot be
/// reached (or only the background refresh failed) the last directory is returned.
#[tauri::command]
pub async fn feishu_directory(app: AppHandle, refresh: Option<bool>) -> Result<Vec<Person>, String> {
    let refresh = refresh.unwrap_or(false);
    let state = app.state::<FeishuApi>();
    let _walking = state.directory.lock().await;
    let path = storage::data_dir(&app)?.join("directory.json");
    let cached: Option<DirectoryCache> = std::fs::read(&path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok());
    if let Some(cache) = cached.as_ref().filter(|c| !refresh && c.fetched_at + DIRECTORY_MAX_AGE > now()) {
        return Ok(cache.people.clone());
    }
    let fetched = if server_url().is_some() {
        let query: &[(&str, &str)] = if refresh { &[("refresh", "1")] } else { &[] };
        match server::call(&app, Method::GET, "/v1/directory", query, None).await {
            Ok(value) => decode::<Vec<Person>>(value),
            Err(failure) => Err(failure.into()),
        }
    } else {
        as_app(&app, |token| async move { fetch_directory(OPEN_API, &token).await }).await.map(|(people, hints)| {
            for hint in hints {
                eprintln!("飞书通讯录：开通「{}」后才能读到{}。", hint.scope, hint.unlocks);
            }
            people
        })
    };
    match fetched {
        Ok(people) => {
            let cache = DirectoryCache { fetched_at: now(), people };
            if let Err(e) = serde_json::to_vec(&cache).map_err(std::io::Error::from).and_then(|bytes| storage::write_atomic(&path, &bytes)) {
                eprintln!("保存通讯录缓存失败：{e}");
            }
            Ok(cache.people)
        }
        Err(failure) => match cached {
            Some(cache) if failure.offline || !refresh => {
                eprintln!("读取飞书通讯录失败，先用上次的缓存：{}", failure.message);
                Ok(cache.people)
            }
            _ => Err(failure.into()),
        },
    }
}

/// The signed-in person's calendar event that overlaps the recording the most, with who was invited.
#[tauri::command]
pub async fn feishu_meeting_attendees(app: AppHandle, start: String, end: String) -> Result<Option<Attendees>, String> {
    let window = meeting_window(&start, &end)?;
    if server_url().is_some() {
        let found = server::call(&app, Method::GET, "/v1/calendar/attendees", &[("start", &start), ("end", &end)], None).await.map_err(Failed::from)?;
        return Ok(decode(found)?);
    }
    Ok(as_user(&app, |token| async move { meeting_attendees(OPEN_API, &token, window).await }).await?)
}

/// Creates a Feishu task as the signed-in person, assigned to `assigneeId`.
#[tauri::command]
pub async fn feishu_create_task(app: AppHandle, task: NewTask) -> Result<CreatedTask, String> {
    let body = &task_body(&task)?;
    if server_url().is_some() {
        let task = serde_json::to_value(&task).map_err(|e| e.to_string())?;
        let created = server::call(&app, Method::POST, "/v1/feishu/tasks", &[], Some(&task)).await.map_err(Failed::from)?;
        return Ok(decode(created)?);
    }
    Ok(as_user(&app, move |token| async move { create_task(OPEN_API, &token.access_token, body).await }).await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{Request, Server};

    fn feishu_error(code: i64, msg: &str) -> ApiError {
        ApiError::Feishu { code, msg: msg.into(), scopes: Vec::new() }
    }

    #[test]
    fn errors_say_what_to_fix() {
        let reply = json!({
            "code": 99991672,
            "msg": "Access denied. One of the following scopes is required: [contact:contact.base:readonly, contact:contact:readonly_as_app].",
            "error": { "permission_violations": [{ "type": "action_scope_required", "subject": "task:task:write" }, { "subject": "task:task:writeonly" }] }
        });
        let scopes = violated_scopes(&reply);
        assert_eq!(scopes, ["task:task:write", "task:task:writeonly"]);
        let message = explain(&ApiError::Feishu { code: 99991672, msg: String::new(), scopes }, Identity::User);
        assert!(message.contains("「task:task:write」「task:task:writeonly」中任意一项") && message.contains("发布新版本"), "{message}");

        // Older replies only list the scopes in the message.
        let reply = json!({ "code": 99991679, "msg": "Unauthorized. required one of these privileges under the user identity: [calendar:calendar:read, calendar:calendar:readonly]" });
        let scopes = violated_scopes(&reply);
        assert_eq!(scopes, ["calendar:calendar:read", "calendar:calendar:readonly"]);
        let message = explain(&ApiError::Feishu { code: 99991679, msg: String::new(), scopes }, Identity::User);
        assert!(message.contains("重新用飞书登录") && message.contains("「calendar:calendar:read」"), "{message}");

        assert_eq!(explain(&ApiError::Feishu { code: 99991672, msg: String::new(), scopes: vec!["a:b".into()] }, Identity::App).matches("「a:b」").count(), 1);
        assert!(explain(&feishu_error(99991677, "token expire"), Identity::User).contains("重新用飞书登录"));
        assert!(explain(&feishu_error(99991663, ""), Identity::User).contains("登录已经过期"));
        assert!(explain(&feishu_error(99991663, ""), Identity::App).contains("访问凭证无效"));
        assert!(explain(&feishu_error(41050, "no user authority"), Identity::App).contains("通讯录权限范围"));
        assert!(explain(&feishu_error(20010, ""), Identity::User).contains("可用范围"));
        assert!(explain(&feishu_error(10015, ""), Identity::App).contains("FEISHU_APP_SECRET"));
        assert!(explain(&feishu_error(1470400, "Invalid Param 'summary'"), Identity::User).ends_with("Invalid Param 'summary'"));
        assert_eq!(explain(&feishu_error(12345, "boom"), Identity::App), "飞书接口出错（12345）：boom");
        assert!(explain(&ApiError::Network("timed out".into()), Identity::App).starts_with("连不上飞书"));
        assert!(explain(&ApiError::Http(502), Identity::App).contains("502"));
    }

    #[test]
    fn directory_from_sample_replies() {
        let departments = vec![
            json!({ "open_department_id": "od-sales", "name": "销售部", "parent_department_id": "0" }),
            json!({ "open_department_id": "od-rd", "name": "研发部" }),
        ];
        let members = vec![
            ("0".to_string(), json!({ "open_id": "ou_boss", "name": "王总", "en_name": "David", "nickname": "David", "job_title": "CEO", "status": { "is_activated": true } })),
            ("od-sales".to_string(), json!({ "open_id": "ou_wang", "name": "王小明", "nickname": "小王", "en_name": " ", "department_ids": ["od-sales", "od-rd"], "status": {} })),
            // Listed again under a second department: one person.
            ("od-rd".to_string(), json!({ "open_id": "ou_wang", "name": "王小明", "department_ids": ["od-sales", "od-rd"] })),
            ("od-rd".to_string(), json!({ "open_id": "ou_left", "name": "已离职", "status": { "is_resigned": true } })),
            ("od-rd".to_string(), json!({ "open_id": "ou_frozen", "name": "暂停", "status": { "is_frozen": true } })),
            ("od-rd".to_string(), json!({ "open_id": "ou_li", "name": "李雷", "en_name": "Li Lei" })),
            ("od-rd".to_string(), json!({ "name": "没有 open_id" })),
        ];
        let (people, hints) = build_directory(&departments, members);
        assert!(hints.is_empty(), "{hints:?}");
        let boss = Person {
            id: "ou_boss".into(),
            name: "王总".into(),
            feishu_open_id: Some("ou_boss".into()),
            department: None,
            title: Some("CEO".into()),
            aliases: vec!["David".into()],
            external: false,
        };
        assert_eq!(people[0], boss);
        assert_eq!(people[1].department.as_deref(), Some("销售部"));
        assert_eq!(people[1].aliases, ["小王"]);
        assert_eq!(people[1].title, None);
        assert_eq!(people[2].department.as_deref(), Some("研发部"));
        assert_eq!(people[2].aliases, ["Li Lei"]);
        assert_eq!(people.len(), 3);

        let json = serde_json::to_value(&people[1]).unwrap();
        assert_eq!(json, json!({ "id": "ou_wang", "name": "王小明", "feishuOpenId": "ou_wang", "department": "销售部", "aliases": ["小王"], "external": false }));
    }

    #[test]
    fn directory_degrades_without_optional_scopes() {
        // What the app gets with only contact:contact.base:readonly and contact:user.base:readonly.
        let departments = vec![json!({ "open_department_id": "od-1" })];
        let members = vec![("od-1".to_string(), json!({ "open_id": "ou_1", "name": "张三" })), ("0".to_string(), json!({ "open_id": "ou_2" }))];
        let (people, hints) = build_directory(&departments, members);
        assert_eq!(people.len(), 1);
        assert_eq!(people[0].department, None);
        let scopes: Vec<_> = hints.iter().map(|h| h.scope).collect();
        assert_eq!(scopes, ["contact:department.base:readonly", "contact:user.employee:readonly", "contact:user.base:readonly"]);
    }

    fn reply(data: Value) -> (u16, String) {
        (200, json!({ "code": 0, "msg": "success", "data": data }).to_string())
    }

    #[tokio::test]
    async fn directory_walk_pages_through_departments() {
        let server = Server::start(|request: &Request| match (request.path().as_str(), request.query("page_token").as_deref()) {
            ("/open-apis/contact/v3/departments/0/children", None) => {
                reply(json!({ "has_more": true, "page_token": "p2", "items": [{ "open_department_id": "od-a", "name": "A 部" }] }))
            }
            ("/open-apis/contact/v3/departments/0/children", Some("p2")) => {
                reply(json!({ "has_more": false, "items": [{ "open_department_id": "od-b", "name": "B 部" }] }))
            }
            ("/open-apis/contact/v3/users/find_by_department", _) => match request.query("department_id").as_deref() {
                Some("0") => reply(json!({ "has_more": false, "items": [{ "open_id": "ou_root", "name": "根" }] })),
                Some("od-a") => reply(json!({ "has_more": false, "items": [{ "open_id": "ou_a", "name": "甲", "status": {} }] })),
                Some("od-b") => reply(json!({ "has_more": false, "items": [{ "open_id": "ou_a", "name": "甲" }, { "open_id": "ou_b", "name": "乙" }] })),
                _ => (400, "{}".into()),
            },
            _ => (404, "not found".into()),
        })
        .await;
        let (people, _) = fetch_directory(&format!("{}/open-apis", server.url()), "t-test").await.unwrap();
        let summary: Vec<_> = people.iter().map(|p| (p.id.as_str(), p.department.as_deref())).collect();
        assert_eq!(summary, [("ou_root", None), ("ou_a", Some("A 部")), ("ou_b", Some("B 部"))]);

        let requests = server.requests();
        assert_eq!(requests.len(), 5);
        assert!(requests.iter().all(|r| r.method == "GET" && r.header("authorization").as_deref() == Some("Bearer t-test")));
        assert_eq!(requests[0].query("fetch_child").as_deref(), Some("true"));
        assert!(requests.iter().all(|r| r.query("page_size").as_deref() == Some("50")));
        assert_eq!(requests[2].query("user_id_type").as_deref(), Some("open_id"));
    }

    #[tokio::test]
    async fn directory_walk_reports_feishu_errors() {
        let server = Server::start(|_: &Request| {
            (400, json!({ "code": 40004, "msg": "no dept authority error", "error": { "log_id": "x" } }).to_string())
        })
        .await;
        let error = fetch_directory(&format!("{}/open-apis", server.url()), "t").await.unwrap_err();
        assert!(matches!(error, ApiError::Feishu { code: 40004, .. }), "{error:?}");
        // Not JSON at all, e.g. a captive portal.
        let server = Server::start(|_: &Request| (502, "<html>bad gateway</html>".into())).await;
        assert!(matches!(fetch_directory(&server.url(), "t").await.unwrap_err(), ApiError::Http(502)));
    }

    #[tokio::test]
    async fn tenant_token_request() {
        let server = Server::start(|_: &Request| (200, r#"{"code":0,"msg":"ok","tenant_access_token":"t-abc","expire":7140}"#.into())).await;
        let creds = FeishuApp { app_id: "cli_x".into(), app_secret: "s3cret".into() };
        let (token, expires_at) = request_tenant_token(&format!("{}/open-apis", server.url()), &creds).await.unwrap();
        assert_eq!(token, "t-abc");
        assert!(expires_at.abs_diff(now() + 7140) <= 2);
        let request = &server.requests()[0];
        assert_eq!((request.method.as_str(), request.path().as_str()), ("POST", "/open-apis/auth/v3/tenant_access_token/internal"));
        assert_eq!(serde_json::from_str::<Value>(&request.body).unwrap(), json!({ "app_id": "cli_x", "app_secret": "s3cret" }));
    }

    fn event(id: &str, start: i64, end: i64) -> Value {
        json!({ "event_id": id, "summary": id, "status": "confirmed",
            "start_time": { "timestamp": start.to_string() }, "end_time": { "timestamp": end.to_string() },
            "event_organizer": { "user_id": "ou_org", "display_name": "组织者" } })
    }

    #[test]
    fn picks_the_event_overlapping_most() {
        let window = (1000, 4600);
        let items = vec![
            event("before", 0, 1500),
            event("main", 900, 4500),
            json!({ "event_id": "all-day", "status": "confirmed", "start_time": { "date": "2026-10-13" }, "end_time": { "date": "2026-10-14" } }),
            { let mut e = event("cancelled", 1000, 4600); e["status"] = json!("cancelled"); e },
            event("after", 4600, 9000),
        ];
        let picked = pick_event(&items, window).unwrap();
        assert_eq!(picked, Picked { event_id: "main".into(), title: "main".into(), organizer: Some("ou_org".into()) });
        // Same overlap: the shorter event is the more specific one.
        let items = vec![event("all-afternoon", 0, 20_000), event("standup", 1000, 4600)];
        assert_eq!(pick_event(&items, window).unwrap().event_id, "standup");
        assert_eq!(pick_event(&[event("after", 4600, 9000)], window), None);
    }

    #[test]
    fn meeting_windows() {
        assert_eq!(meeting_window("2026-10-13T01:00:00Z", "2026-10-13T02:00:00Z"), Ok((1_791_853_200, 1_791_856_800)));
        assert_eq!(meeting_window("2026-10-13T09:00:00+08:00", "2026-10-13T09:00:00+08:00"), Ok((1_791_853_200, 1_791_853_260)));
        assert!(meeting_window("2026-10-13T02:00:00Z", "2026-10-13T01:00:00Z").is_err());
        assert!(meeting_window("today", "2026-10-13T01:00:00Z").unwrap_err().contains("today"));
    }

    #[tokio::test]
    async fn attendees_of_a_recurring_instance() {
        let server = Server::start(|request: &Request| {
            let path = request.path();
            match path.as_str() {
                "/open-apis/calendar/v4/calendars/primary" => {
                    reply(json!({ "calendars": [{ "calendar": { "calendar_id": "feishu.cn_abc@group.calendar.feishu.cn" }, "user_id": "u1" }] }))
                }
                "/open-apis/calendar/v4/calendars/feishu.cn_abc@group.calendar.feishu.cn/events/instance_view" => reply(json!({ "items": [
                    event("series-1_1791853200", 1_791_853_200, 1_791_856_800),
                ]})),
                // Feishu does not know the instance id; the series does.
                "/open-apis/calendar/v4/calendars/feishu.cn_abc@group.calendar.feishu.cn/events/series-1_1791853200/attendees" => {
                    (404, json!({ "code": 193001, "msg": "event not found" }).to_string())
                }
                "/open-apis/calendar/v4/calendars/feishu.cn_abc@group.calendar.feishu.cn/events/series-1/attendees" => reply(json!({ "has_more": false, "items": [
                    { "type": "user", "user_id": "ou_a", "rsvp_status": "accept" },
                    { "type": "user", "user_id": "ou_declined", "rsvp_status": "decline" },
                    { "type": "user", "user_id": "ou_org", "rsvp_status": "decline", "is_organizer": true },
                    { "type": "user", "user_id": "ou_guest", "is_external": true },
                    { "type": "resource", "room_id": "omm_room" },
                    { "type": "chat", "attendee_id": "chat_1", "chat_id": "oc_1", "rsvp_status": "needs_action" },
                ]})),
                "/open-apis/calendar/v4/calendars/feishu.cn_abc@group.calendar.feishu.cn/events/series-1/attendees/chat_1/chat_members" => reply(json!({ "has_more": false, "items": [
                    { "open_id": "ou_b", "rsvp_status": "needs_action" },
                    { "open_id": "ou_a", "rsvp_status": "accept" },
                    { "open_id": "ou_c", "rsvp_status": "removed" },
                ]})),
                _ => (404, json!({ "code": 404, "msg": path }).to_string()),
            }
        })
        .await;
        let token = UserToken { access_token: "u-test".into(), open_id: "ou_me".into() };
        let found = meeting_attendees(&format!("{}/open-apis", server.url()), &token, (1_791_853_300, 1_791_856_000)).await.unwrap().unwrap();
        assert_eq!(found, Attendees { event_title: "series-1_1791853200".into(), attendee_ids: vec!["ou_a".into(), "ou_org".into(), "ou_b".into(), "ou_me".into()] });

        let requests = server.requests();
        assert!(requests.iter().all(|r| r.header("authorization").as_deref() == Some("Bearer u-test")));
        assert_eq!(requests[0].method, "POST");
        assert_eq!(requests[1].query("start_time").as_deref(), Some("1791853300"));
        assert_eq!(requests[1].query("end_time").as_deref(), Some("1791856000"));
        assert!(requests[2..].iter().all(|r| r.query("user_id_type").as_deref() == Some("open_id")));
    }

    #[tokio::test]
    async fn attendees_when_the_list_is_hidden_or_nothing_matches() {
        let server = Server::start(|request: &Request| match request.path().as_str() {
            "/open-apis/calendar/v4/calendars/primary" => reply(json!({ "calendars": [{ "calendar": { "calendar_id": "cal" } }] })),
            "/open-apis/calendar/v4/calendars/cal/events/instance_view" => reply(json!({ "items": [event("e1", 0, 100)] })),
            _ => (403, json!({ "code": 194001, "msg": "no permission to list event attendees" }).to_string()),
        })
        .await;
        let base = format!("{}/open-apis", server.url());
        let token = UserToken { access_token: "u".into(), open_id: "ou_me".into() };
        let found = meeting_attendees(&base, &token, (10, 90)).await.unwrap().unwrap();
        assert_eq!(found.attendee_ids, ["ou_org", "ou_me"]);
        assert_eq!(meeting_attendees(&base, &token, (200, 300)).await.unwrap(), None);
    }

    fn new_task(title: &str, due: Option<&str>, assignee: &str) -> NewTask {
        NewTask { title: title.into(), description: Some("  ".into()), due: due.map(String::from), assignee_id: assignee.into() }
    }

    #[test]
    fn all_day_due_dates() {
        // The example in Feishu's task docs: 1682899200000 shows as 2023-05-01 everywhere.
        assert_eq!(all_day_timestamp("2023-05-01").as_deref(), Some("1682899200000"));
        // 2026-10-20 00:00 UTC, i.e. 08:00 that day in Beijing, so the date part is the 20th in both.
        assert_eq!(all_day_timestamp("2026-10-20").as_deref(), Some("1792454400000"));
        assert_eq!(all_day_timestamp("2026-10-32"), None);
        assert_eq!(all_day_timestamp("2026/10/20"), None);
    }

    #[test]
    fn task_bodies() {
        let body = task_body(&new_task(" 整理报价单 ", Some("2026-10-20"), "ou_wang")).unwrap();
        assert_eq!(
            body,
            json!({
                "summary": "整理报价单",
                "members": [{ "id": "ou_wang", "type": "user", "role": "assignee" }],
                "origin": { "platform_i18n_name": { "zh_cn": "EchoMind 会议纪要", "en_us": "EchoMind" } },
                "due": { "timestamp": "1792454400000", "is_all_day": true },
            })
        );
        let mut task = new_task("t", None, "ou_wang");
        task.description = Some("见会议第 3 段".into());
        let body = task_body(&task).unwrap();
        assert_eq!(body["description"], "见会议第 3 段");
        assert!(body.get("due").is_none());
        assert_eq!(task_body(&new_task(&"长".repeat(3100), None, "ou_x")).unwrap()["summary"].as_str().unwrap().chars().count(), 3000);

        assert!(task_body(&new_task("  ", None, "ou_wang")).is_err());
        assert!(task_body(&new_task("t", None, "person-12")).unwrap_err().contains("通讯录"));
        assert!(task_body(&new_task("t", Some("下周三"), "ou_wang")).unwrap_err().contains("下周三"));
    }

    #[tokio::test]
    async fn task_creation_request() {
        let server = Server::start(|_: &Request| {
            reply(json!({ "task": { "guid": "83912691-2e43-47fc-94a4-d512e03984fa", "url": "https://applink.feishu.cn/client/todo/detail?guid=83912691", "summary": "x" } }))
        })
        .await;
        let body = task_body(&new_task("整理报价单", Some("2026-10-20"), "ou_wang")).unwrap();
        let created = create_task(&format!("{}/open-apis", server.url()), "u-token", &body).await.unwrap();
        assert_eq!(created.guid, "83912691-2e43-47fc-94a4-d512e03984fa");
        assert_eq!(serde_json::to_value(&created).unwrap()["url"], "https://applink.feishu.cn/client/todo/detail?guid=83912691");

        let request = &server.requests()[0];
        assert_eq!((request.method.as_str(), request.path().as_str()), ("POST", "/open-apis/task/v2/tasks"));
        assert_eq!(request.query("user_id_type").as_deref(), Some("open_id"));
        assert_eq!(request.header("authorization").as_deref(), Some("Bearer u-token"));
        assert_eq!(serde_json::from_str::<Value>(&request.body).unwrap(), body);

        let server = Server::start(|_: &Request| reply(json!({ "task": { "guid": "g" } }))).await;
        let created = create_task(&server.url(), "u", &body).await.unwrap();
        assert_eq!(serde_json::to_value(&created).unwrap(), json!({ "guid": "g" }));
    }

    // Live, read-only checks against the real tenant: `cargo test -- --ignored live_`.
    // They print counts and codes only.

    #[tokio::test]
    #[ignore]
    async fn live_directory() {
        let creds = config::feishu().expect("FEISHU_APP_ID / FEISHU_APP_SECRET");
        let (token, expires_at) = request_tenant_token(OPEN_API, &creds).await.unwrap();
        println!("tenant token ok, expires in {} s", expires_at - now());
        let (people, hints) = fetch_directory(OPEN_API, &token).await.unwrap();
        println!(
            "people {}, with department {}, with title {}, with aliases {}",
            people.len(),
            people.iter().filter(|p| p.department.is_some()).count(),
            people.iter().filter(|p| p.title.is_some()).count(),
            people.iter().filter(|p| !p.aliases.is_empty()).count()
        );
        println!("missing optional scopes: {:?}", hints.iter().map(|h| h.scope).collect::<Vec<_>>());
    }

    /// Uses the desktop app's saved session as is; it does not refresh (refresh tokens are single-use).
    #[tokio::test]
    #[ignore]
    async fn live_attendees() {
        let path = std::env::var("HOME").unwrap() + "/Library/Application Support/com.evanbyte.echomind/feishu-session.json";
        let session: Value = serde_json::from_slice(&std::fs::read(path).expect("signed in")).unwrap();
        assert!(session["expires_at"].as_u64().unwrap() > now() + 60, "the saved token has expired; open the app to refresh it");
        let token = UserToken {
            access_token: session["access_token"].as_str().unwrap().into(),
            open_id: session["profile"]["openId"].as_str().unwrap().into(),
        };
        let window = (now() as i64 - 7 * 86_400, now() as i64);
        match meeting_attendees(OPEN_API, &token, window).await {
            Ok(found) => println!("event found: {}, attendees: {}", found.is_some(), found.map_or(0, |f| f.attendee_ids.len())),
            Err(error) => {
                if let ApiError::Feishu { code, scopes, .. } = &error {
                    println!("code {code}, scopes {scopes:?}");
                }
                println!("message: {}", explain(&error, Identity::User));
            }
        }
    }
}
