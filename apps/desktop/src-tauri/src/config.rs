//! Secrets and settings, read in one place.
//!
//! The environment wins. Debug builds also read apps/desktop/.env.local, so `pnpm tauri dev`
//! works without exporting anything; release builds read only the environment until a server
//! holds the secrets. Nothing here derives Debug: values must never end up in a log.

#[cfg(debug_assertions)]
const ENV_FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../.env.local");

const DEEPSEEK_BASE_URL: &str = "https://api.deepseek.com";
const DEEPSEEK_MODEL: &str = "deepseek-flash";

/// A non-empty setting. The file is read on every call, so edits apply without a restart.
pub fn get(key: &str) -> Option<String> {
    if let Some(value) = std::env::var(key).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
        return Some(value);
    }
    #[cfg(debug_assertions)]
    if let Ok(text) = std::fs::read_to_string(ENV_FILE) {
        return lookup(&text, key);
    }
    None
}

/// dotenv rules: `#` comments, optional `export`, quoted or bare values, the last line wins.
#[cfg_attr(not(any(debug_assertions, test)), allow(dead_code))]
fn lookup(text: &str, key: &str) -> Option<String> {
    let mut found = None;
    for line in text.lines() {
        let line = line.trim();
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((name, value)) = line.split_once('=') else { continue };
        if name.trim() != key {
            continue;
        }
        let value = value.trim();
        let value = match value.chars().next() {
            Some(quote @ ('"' | '\'')) => value[1..].split(quote).next().unwrap_or_default(),
            // A bare value ends at an inline comment.
            _ => value.split(" #").next().unwrap_or_default().trim(),
        };
        found = Some(value.to_string()).filter(|v| !v.is_empty());
    }
    found
}

pub struct FeishuApp {
    pub app_id: String,
    pub app_secret: String,
}

pub fn feishu() -> Option<FeishuApp> {
    Some(FeishuApp { app_id: get("FEISHU_APP_ID")?, app_secret: get("FEISHU_APP_SECRET")? })
}

pub struct DeepSeek {
    pub api_key: Option<String>,
    /// Without a trailing slash.
    pub base_url: String,
    pub model: String,
}

pub fn deepseek() -> DeepSeek {
    DeepSeek {
        api_key: get("DEEPSEEK_API_KEY"),
        base_url: get("DEEPSEEK_BASE_URL").unwrap_or_else(|| DEEPSEEK_BASE_URL.into()).trim_end_matches('/').to_string(),
        model: get("DEEPSEEK_MODEL").unwrap_or_else(|| DEEPSEEK_MODEL.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_dotenv_lines() {
        let text = "# keys\nFEISHU_APP_ID=cli_1\nexport DEEPSEEK_API_KEY = \"sk-a#b\" \nDEEPSEEK_MODEL=m1 # pinned\nEMPTY=\nDEEPSEEK_MODEL='m2'\n";
        assert_eq!(lookup(text, "FEISHU_APP_ID").as_deref(), Some("cli_1"));
        assert_eq!(lookup(text, "DEEPSEEK_API_KEY").as_deref(), Some("sk-a#b"));
        assert_eq!(lookup(text, "DEEPSEEK_MODEL").as_deref(), Some("m2"));
        assert_eq!(lookup(text, "EMPTY"), None);
        assert_eq!(lookup(text, "MISSING"), None);
    }
}
