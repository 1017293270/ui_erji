# Desktop IPC contract

The webview (`apps/desktop/src`) talks to the Rust shell (`apps/desktop/src-tauri`) only
through the Tauri commands and events below. The TypeScript wrappers live in
`apps/desktop/src/lib/native.ts`. All JSON is camelCase and matches the zod schemas in
`packages/shared/src/meeting.ts` where a type from there is named.

Secrets (Feishu App Secret, DeepSeek key, Feishu tokens) never cross this boundary, and the app
carries none: the EchoMind server (`apps/server`, `https://58.87.77.127:8443`) holds them and makes
the Feishu and DeepSeek calls (`src-tauri/src/server.rs`). The app trusts only EchoMind's own CA
for it (`src-tauri/certs/echomind-ca.pem`, compiled in) and keeps its session in
`server-session.json`. `ECHOMIND_SERVER_URL` points it at another server. Debug builds can set
`ECHOMIND_SERVER_URL=direct` to call Feishu and DeepSeek straight from Rust with the keys in
`apps/desktop/.env.local` (`FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `DEEPSEEK_API_KEY`, optional
`DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL`); that path goes away once the server is accepted. The
environment wins over the file. All of this lives in `src-tauri/src/config.rs`.

Errors are returned as a Chinese sentence that says what to do (`Result<_, String>`).

## Files

Everything lives under the app data directory
(`~/Library/Application Support/com.evanbyte.echomind/` on macOS,
`%APPDATA%\com.evanbyte.echomind\` on Windows):

```
recordings/<meetingId>/        one folder per meeting; <meetingId> is the folder name, e.g. rec-1791884868281
  manifest.json                written by echomind-capture
  mic-0001.wav, system-0001.wav …
  meeting.json                 the Meeting (shared schema), written by meeting_save
  transcript.json              the Transcript, written by the transcriber
models/                        transcription models (downloaded on first use)
directory.json                 last Feishu directory, for offline use: { fetchedAt (Unix s), people: Person[] }
server-session.json            the EchoMind session and the signed-in profile (0600)
feishu-session.json            Feishu tokens, direct mode only (0600)
```

A meeting's id is its recording folder name. Ids must match `^[A-Za-z0-9._-]{1,80}$`.

## Capture (exists)

`capture_start`, `capture_command(command)`, `capture_meetings`, `capture_permissions`,
`capture_request_mic`, `capture_request_system_audio`, `open_privacy_settings(kind)`,
`reveal_recordings`, `show_main_window`; events on `capture://event` (see `native.ts`). The
`started` event carries `out`, the recording folder.

`capture_start` checks the permissions first: it shows the prompts nobody has answered yet,
refuses to start without the microphone, and starts without system audio but warns. Every
failure is also sent as an `error` event, so a button that calls it needs no error handling of
its own. An `error` event may carry `settings` (`microphone` | `systemAudio`); the toast then
offers to open that page through `open_privacy_settings`.

The sidecar is `native/macos-capture` (Swift) on macOS and `native/windows-capture` (Rust, WASAPI)
on Windows, with the same protocol. On Windows `capture_permissions` never says `undetermined`
(desktop apps get no prompt there), `systemAudio` is always `granted`, and `capture_request_mic`
opens the microphone privacy settings when access is off.

## Meetings (storage)

| Command | Args | Returns |
| --- | --- | --- |
| `meetings_list` | – | `Meeting[]`, newest `startedAt` first; folders without a valid `meeting.json` are skipped |
| `meeting_save` | `meeting: Meeting` | `()` — atomic write of `recordings/<id>/meeting.json` (creates the folder) |

Rust stores the Meeting JSON as given (it does not re-validate the schema). On read, `id` is set
to the folder name. `startedAt` is compared as a point in time; an ISO string without an
offset is taken as Beijing time.

## DeepSeek proxy

| Command | Args | Returns |
| --- | --- | --- |
| `llm_status` | – | `{ configured: boolean, model: string, baseUrl: string, via: "server" \| "direct" }` |
| `llm_chat` | `body: object` (OpenAI-compatible chat/completions body) | `{ status: number, body: string }` — the key is added by the server (or by Rust in direct mode); failure to get DeepSeek's reply is an `Err` |

The minutes engine runs in the webview and uses `llm_chat` as its `fetch`. The body goes to the
server's `POST /v1/llm/chat`, which pins the model and forwards it to DeepSeek; DeepSeek's reply,
4xx/5xx included, comes back as `{ status, body }` (the server marks it with
`X-EchoMind-Upstream`), so the engine handles retries. `Err` carries the server's own sentence:
signed out, rate limited, DeepSeek unreachable or silent for 10 minutes, not configured.

## Feishu

| Command | Args | Returns |
| --- | --- | --- |
| `feishu_status` | – | `{ configured, server, company: { joinCode, name } \| null, admin, user: FeishuProfile \| null, redirectUri, missingScopes: string[] }` |
| `feishu_login` | `joinCode?: string` | `FeishuProfile`. `joinCode` picks the company; left out, the one this computer signed in to last |
| `feishu_cancel` / `feishu_logout` | – | exists |
| `feishu_forget_company` | – | forgets the company, so the next sign-in asks for a join code |
| `companies_list` | – | `{ companies: Company[], permissions: { scopes: { tenant, user } } }` — admins only |
| `companies_add` | `appId, appSecret` | `Company` — checked with Feishu first |
| `companies_update` | `id, action: "check" \| "disable" \| "enable"` | `Company` |
| `companies_replace_secret` | `id, appSecret` | `Company` — checked with Feishu first |
| `feishu_directory` | `refresh?: boolean` | `Person[]` — every active member (id = open_id, `feishuOpenId` = open_id, department name, `title` = job title, `aliases` = en_name / nickname); falls back to `directory.json` offline |
| `feishu_meeting_attendees` | `start: string, end: string` (ISO) | `{ eventTitle: string, attendeeIds: string[] } \| null` — the signed-in user's calendar event overlapping the window most |
| `feishu_create_task` | `task: { title, description?, due?: "YYYY-MM-DD", assigneeId: string }` | `{ guid: string, url?: string }` — created as the signed-in user (task v2) |

Each company signs in through its own Feishu app, so the company comes first: its six-character
join code (`server-company.json`, kept after signing out) picks it, and `server: true` with
`company: null` means the UI has to ask for one. People signed in before join codes existed get
their company remembered from `GET /v1/me`. `admin` says whether 公司管理 may be opened; the server
checks again on every `companies_*` call. See `docs/companies.md`.

Sign-in asks for `offline_access task:task:write calendar:calendar:read calendar:calendar.event:read`
(the server says which, with the company's App ID, at `GET /v1/auth/feishu/config?company=<join code>`). The browser comes back
to `http://127.0.0.1:43517/feishu/callback`; the app hands the code and PKCE verifier to the
server, which signs in to Feishu, keeps the person's tokens sealed, and returns an EchoMind
session. `missingScopes` lists any the grant lacks, so the UI can ask for a fresh sign-in
(`[]` when nobody is signed in); `feishu_status` checks the session with the server
(`GET /v1/me`) and, offline, answers with what was saved at sign-in. Any `401` from the server
signs the app out.

`feishu_directory`, `feishu_meeting_attendees` and `feishu_create_task` ask the server
(`GET /v1/directory`, `GET /v1/calendar/attendees`, `POST /v1/feishu/tasks`), which makes the same
Feishu calls described below with the app's token or the person's.

- `feishu_directory`: without `refresh` a cache younger than 12 hours answers. When Feishu cannot be
  reached, or a background (non-`refresh`) fetch fails, the cache answers; an explicit `refresh` that
  Feishu rejects returns the `Err` so the UI can show what to fix. Resigned, exited and frozen
  members are left out. `department`/`title` are omitted when the app lacks the scope to read them.
- `feishu_meeting_attendees`: recurring meetings count (instances are expanded); all-day and
  cancelled events do not. `attendeeIds` are in-tenant open_ids of invited users and members of
  invited groups, minus people who declined, plus the organizer and the signed-in user. If the
  organizer hid the guest list, only those two. `null` when no event overlaps the window.
- `feishu_create_task`: `assigneeId` must be an open_id (`ou_…`). `due` becomes an all-day due date
  that shows as that same date for everyone. The task's source shows as EchoMind in Feishu.

## Transcription

| Command | Args | Returns |
| --- | --- | --- |
| `transcribe_models` | – | `{ ready: boolean, downloadBytes: number, models: { id, name, bytes, ready }[] }` |
| `transcribe_download` | – | `()` — progress on `transcribe://download` `{ received, total }` |
| `transcribe_start` | `meetingId: string, scene?: "in-person" \| "online", speakers?: number` | `()` — runs in the background |

The work runs in the `echomind-transcribe` sidecar (`native/transcriber`, built by its
`build.sh`), one meeting at a time; models live in `models/`. A finished run also writes
`recordings/<id>/transcript.json`, and `transcribe_start` answers from that file when it exists.
Subscribe to the events before calling `transcribe_start`.

Without `scene` and `speakers`, the transcriber judges from the audio whether the meeting was in
person (everyone on the microphone, told apart by voice) or online (the microphone is the person
recording), and records it as `transcript.scene`. Passing either transcribes again as told, even
when `transcript.json` exists, and replaces the file only if the new run succeeds. `speakers`
(1–20) is how many people spoke: in person, everyone in the room; online, the other side.

Events on `transcribe://progress`:

```
{ meetingId, stage: "prepare" | "speech" | "speakers" | "text", progress: 0..1 }   progress restarts at 0 in each stage
{ meetingId, stage: "done", transcript: Transcript }
{ meetingId, stage: "error", kind: string, message: string }   kind "models_missing": download the models, then start again
```

For one overall bar, the stages take roughly speech 7 %, speakers 31 %, text 62 % of the time.

Transcript rules: speaker `S1` is the microphone (`label: "我"`, `track: "mic"`, `source: "self"`,
`personId: null` — the webview fills it); remote voices are `S2…` (`label: "说话人 2"…`,
`track: "system"`, `source: "unknown"`). Segments are sorted by `start`, ids `seg-0001…`,
times in ms from the recording start (pauses leave gaps), text with punctuation.
