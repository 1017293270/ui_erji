# @echomind/minutes-engine

Turns a meeting transcript into chapters, minutes and todos with DeepSeek. Every chapter, conclusion, decision, open question and todo cites transcript segment ids, and code checks those citations. Owners and due dates are worked out in code from what the model quotes.

```
provider/   LlmProvider: OpenAICompatibleProvider (plain fetch) → DeepSeekProvider preset; MockProvider for tests
prompts/    Chinese prompts, versioned (chapters-v1, minutes-v1, todos-v1, overview-v1), transcript rendering
validate/   zod + code checks: citations, chapter tiling, retry triggers
resolve/    owner resolver, due-date resolver, duplicate-todo merge (deterministic, unit-tested)
engine.ts   MinutesEngine: chapters() / minutes() / todos()
pipeline.ts runPipeline(meeting, { provider, directory }): chapters, then minutes and todos in parallel
cli.ts      terminal runner
```

## Run it

```sh
pnpm --filter @echomind/minutes-engine test        # vitest; the live test skips itself without a key
pnpm --filter @echomind/minutes-engine typecheck

# The fixture meeting against the real API
export DEEPSEEK_API_KEY=sk-...                      # https://platform.deepseek.com/api_keys
pnpm --filter @echomind/minutes-engine minutes --fixture --out minutes-result.json
pnpm --filter @echomind/minutes-engine test src/live.test.ts   # the live assertions

# Without a key: show the output format using the fixture's gold answers
pnpm --filter @echomind/minutes-engine minutes --mock
```

`minutes` also takes a file: `minutes path/to/meeting.json`, where the file holds a `Meeting` with a transcript or a bare `Transcript`. For a bare transcript, add `--date 2026-10-12T10:00:00+08:00`, and add `--people directory.json` for the directory. `--out` writes `{ minutes, todos, usage, issues }`. Relative paths resolve from the directory where you ran the command.

The CLI runs through **tsx**. Node 24 strips types natively, but it cannot resolve the extensionless imports that `@echomind/shared` uses (`./meeting`), so `node --experimental-strip-types src/cli.ts` fails. tsx is a dev dependency of this package.

| env | default | |
|---|---|---|
| `DEEPSEEK_API_KEY` | (required) | building a `DeepSeekProvider` without it throws `MissingApiKeyError`, whose message says how to set it |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | |
| `DEEPSEEK_MODEL` | `deepseek-flash` | |
| `DEEPSEEK_THINKING` | off | `1` turns thinking mode on (adds 16k to max_tokens and drops temperature) |
| `DEEPSEEK_TIMEOUT_MS` | `300000` | per attempt |

## DeepSeek API: what was checked (2026-10-13)

The API changed a lot in 2026, so these facts come from the official docs as of 2026-10-13, not from memory:

- **Endpoint.** The OpenAI format uses base URL `https://api.deepseek.com` with `POST /chat/completions` and a `Bearer` key. An Anthropic-format endpoint also exists at `/anthropic`; we do not use it. ([quick start](https://api-docs.deepseek.com/))
- **Models.** There are two models ([models & pricing](https://api-docs.deepseek.com/quick_start/pricing), [change log](https://api-docs.deepseek.com/updates)):
  - `deepseek-flash` is DeepSeek-V4.1-Flash, released 2026-09-10. **This is our default.**
  - `deepseek-v4-pro` is V4-Pro-0813. Per the [2026-09-10 release note](https://api-docs.deepseek.com/news/news260910), V4-Pro is being phased out: since 2026-09-14 04:00 UTC, `deepseek-v4-pro` requests are routed to V4.1-Flash at Flash prices until V4.1-Pro ships. The pricing page still lists V4-Pro separately.
  - The legacy name `deepseek-v4-flash` is still accepted and routed to V4.1-Flash.
  - **`deepseek-chat` and `deepseek-reasoner` are gone.** The [2026-04-24 note](https://api-docs.deepseek.com/zh-cn/news/news260424) scheduled them for discontinuation on 2026-07-24, and they are no longer listed. Do not use them.
- **Limits.** Context is 1M tokens and output is capped at 384K. `max_tokens` defaults to 8K in non-thinking mode, 64K in thinking mode, and 128K when `reasoning_effort` is `max`. ([chat completion API](https://api-docs.deepseek.com/api/create-chat-completion))
- **Thinking mode.** Thinking is **on by default** (effort `high`). In the OpenAI format, turn it off with `"thinking": {"type": "disabled"}` (or `reasoning_effort: "none"`). In thinking mode `temperature` has no effect, and the chain-of-thought comes back in `reasoning_content`. ([thinking mode](https://api-docs.deepseek.com/guides/thinking_mode)) We send `thinking: disabled` because extraction from a JSON example does not need it, and it is cheaper and faster without it.
- **JSON Output.** Set `response_format: {"type": "json_object"}`. The system or user prompt must contain the word "json" and an example of the format. Otherwise, the API reference warns, the request may run until the token limit. Set `max_tokens` high enough that the JSON is not cut off. The API *may occasionally return empty content*. Both models support JSON Output, and the official example runs on `deepseek-flash` in its default thinking mode. ([JSON mode](https://api-docs.deepseek.com/guides/json_mode))
- **Usage.** The response reports `prompt_tokens` (= `prompt_cache_hit_tokens + prompt_cache_miss_tokens`), `completion_tokens`, `prompt_tokens_details.cached_tokens` (same as the hit count) and `completion_tokens_details.reasoning_tokens`. Context caching on disk is on by default, prefix-based and best-effort, and unused caches are cleared within hours to days. ([context caching](https://api-docs.deepseek.com/guides/kv_cache))
- **Prices** (CNY per 1M tokens, off-peak/peak). For `deepseek-flash`: input cache hit 0.02/0.04, cache miss 1/2, output 4/8. Peak hours are 09:00–12:00 and 14:00–18:00 Beijing time on working days. One run on the fixture costs a fraction of a fen.
- **Errors** ([error codes](https://api-docs.deepseek.com/quick_start/error_codes)):
  - 400 invalid format, 401 wrong key, 402 insufficient balance and 422 invalid parameters: fix the request; never retry.
  - 429 rate limit: the account-level concurrency limit was hit (2500 concurrent for flash, 500 for pro; [rate limit](https://api-docs.deepseek.com/quick_start/rate_limit)).
  - 500 server error and 503 overloaded: "retry after a brief wait".
  - `finish_reason` can also be `length`, `content_filter` or `insufficient_system_resource`.
- **Timeouts.** While a request waits, the server sends blank lines for non-streaming requests and `: keep-alive` comments when streaming. It closes the connection if inference has not started within 10 minutes. ([rate limit](https://api-docs.deepseek.com/quick_start/rate_limit))
- **Token estimate.** 1 Chinese character ≈ 0.6 token and 1 English character ≈ 0.3 token. ([token usage](https://api-docs.deepseek.com/quick_start/token_usage))

How the provider handles this:

- **Retries.** 429, 5xx, 408, network errors, timeouts, `insufficient_system_resource` and non-JSON gateway pages are retried up to 3 times. The backoff is exponential with jitter (1 s, 2 s, 4 s, capped at 30 s) and honours `Retry-After`.
- **No retries.** 400, 401, 402, 404 and 422 are never retried. A 429 whose body says quota or balance counts as `balance`.
- **Empty content** in JSON mode gets one immediate free retry.
- **Unusable output.** `finish_reason: length` and unparseable content become `invalid_json`. The engine decides whether to retry these, and on a truncated reply it doubles `max_tokens`.
- **Keep-alive lines** are tolerated because the body is read with `text()` and trimmed.
- **Error type.** Failures are thrown as `LlmError` with `kind` set to `auth | balance | rate_limit | bad_request | server | network | invalid_json`, plus `status`, `retryable` and a Chinese `userMessage`. Aborting through the caller's `signal` stops the call immediately.

## Other providers

`OpenAICompatibleProvider` is the reusable part, and DeepSeek is a preset of it. Qwen (DashScope compatible mode) and a private vLLM/SGLang deployment of DeepSeek open weights speak the same protocol:

```ts
new OpenAICompatibleProvider({
  name: "vllm", label: "私有化模型",
  baseUrl: "http://10.0.0.8:8000/v1",          // up to, not including, /chat/completions
  model: "deepseek-ai/DeepSeek-V4-Flash",
  extraBody: { chat_template_kwargs: { thinking: false } }, // provider-specific switches go here
  jsonMode: true,                              // false for servers without response_format
});
```

## Prompts

Each task has its own file under `prompts/`. Every system prompt follows the same layout:

- The first line is `# EchoMind 任务：<task>（<version>）`. It names the prompt version in logs, and `MockProvider` routes on it.
- A shared role and transcript-format paragraph.
- The task, numbered rules, and "只输出一个 JSON 对象" followed by a complete JSON example, as DeepSeek JSON mode requires.

The user message carries the meeting date and duration, the participants with their aliases, the speaker list, the chapters (minutes only) and the transcript, one line per segment:

```
[seg-0012 06:53 李娜] 那如果用户开的是外放，不戴耳机呢？
[seg-0019 10:53 说话人 5] 我补充一个测试的问题……
```

Names replace diarization labels once a speaker is resolved; unnamed speakers keep their label, and the model is told not to guess who they are.

The model never resolves people or dates:

- **Todos.** The model copies `ownerMention` exactly as said (小王 / 我 / 赵总 / null) and points at `ownerSegmentId`, the line that assigned or claimed the todo. It copies `dueText` as said, without converting it.
- **Minutes.** Minutes exclude todos, and every point needs 1–4 evidence ids.
- **Chapters.** Chapters must tile the transcript.

The system prompt is identical across calls of a task, so a retry or a regeneration of the same meeting hits DeepSeek's prefix cache.

## Grounding, repair and retry

After each call, code parses the answer with lenient zod schemas and then checks it:

- **Citations.**
  - Ids are matched exactly. Near-misses are accepted only when they map to exactly one segment (`seg-13`, `SEG-0013`, `「seg-0013」`). Ranges like `seg-0049~seg-0051` are expanded, up to 8 segments.
  - Unknown ids are dropped.
  - A point or todo left with no valid evidence is dropped.
  - A todo's `ownerSegmentId` is always added to its evidence.
- **Chapters** become contiguous, ordered, non-overlapping and cover every segment:
  - Chapters are sorted.
  - A chapter whose start and end ids are both unknown is dropped. A single unknown boundary is inferred from the neighbouring chapters.
  - Reversed boundaries are swapped. A chapter nested inside another is merged into it.
  - Overlaps are cut at the later chapter's start.
  - Gaps, including any at the start or end, are absorbed into the preceding chapter.
  - Ids are renumbered `ch-1…`, and the times come from the segments.
- **Issue severity.** Every repair is recorded as an `Issue`, returned by `runPipeline` and printed by the CLI:
  - **minor**: fixed silently.
  - **major**: fixed, but the answer looks unreliable. This covers more than half of the items losing their evidence, a gap of more than 8 segments or more than 5 minutes, or an empty overview.
  - **fatal**: nothing usable, such as invalid JSON, a truncated reply, a missing array, or no chapter with a real id.
- **One retry.** On a fatal or major issue, the task is asked once more with the problems appended under 「上一次输出的问题」. After the retry, a repaired answer is accepted, and its issues are kept. A second fatal answer throws `MinutesEngineError(task, issues)` with a Chinese `userMessage`. Provider errors (auth, balance, network…) are never retried at this level.
- **Final check.** The final `Minutes` and each `Todo` are parsed with the shared zod schemas.

## Owners (resolve/owner.ts)

| what was said | result | confidence |
|---|---|---|
| 「我 / 我来 / 我这边」 by a named speaker | `self-claimed`, the speaker's person | 0.95, lower for weak voiceprints (0.6 + 0.4 × score) |
| 「我们 / 咱们」 | `self-claimed`, the speaker | ≤ 0.6 |
| a participant's exact name or alias | `assigned` | 0.9 |
| a participant, contained name (建国 → 赵建国) | `assigned` | 0.85 |
| a participant, without honorific (建国总) | `assigned` | 0.8 |
| a participant, surname + honorific only (王总) | `assigned` | 0.7 |
| matched only in the directory | `directory` | 0.85 / 0.75 / 0.7 / 0.55 |
| the named owner then says 「我…」 in the evidence (赵总您批一下 → 我这周内批掉) | `self-claimed`, the owner's speaker | 0.92 |
| a 「好的 / 没问题」 or a refusal from the owner | basis unchanged | +0.03 or −0.2 |
| claimed by an unnamed speaker | `unresolved`, `ownerSpeakerId` kept | 0.5 |
| ambiguous (two people called 小王), unknown, or 「你」 | `unresolved` | 0.3 |
| nobody | `unresolved` | 0.2 |

How a mention is matched:

- Participants are tried before the directory: exact match first, then a name that contains the mention, then the mention with honorifics (总/经理/哥/姐/老师…) and 小/老/阿 stripped, then surname.
- An exact directory alias beats a participant who merely shares the surname. This is the case of 孙经理 when a participant 孙丽 is also present.
- 「我」 is trusted only on a first-person line. Otherwise the claim is looked for in the evidence, so 「我这两周排满了」 does not count as a claim.
- `external` comes from the person.
- `ownerSpeakerId` is the speaker of the line that established the owner, matching the fixture's gold todos.

## Due dates (resolve/due.ts)

Due dates resolve against the meeting day in Asia/Shanghai, with Monday as the first day of the week:

- 今天/明天/后天/大后天.
- 周X/星期X/礼拜X: this week, or next week if that day has passed. 本周X/这周X: this week. 下周X: next week. 下下周X: the week after next.
- 这周内/本周内: Friday, or Sunday if said on a weekend. 下周内: next Friday. 周末: Sunday.
- 月底/月底前: the last day of the month. 下个月底, X月底, 月中 and 年底 are handled the same way.
- X月X号/日 and 10/28: the next occurrence of that date. X号: this month, or next month if the day has passed.
- N天内/两周内/N个月内: counted from the meeting day.

Chinese and full-width numerals both work. Anything else, such as 尽快, gives `null`.

## Long meetings

If the rendered transcript exceeds `maxTranscriptTokens` (default 32k by DeepSeek's 0.6 token per character estimate, roughly three to four hours of speech), each task runs per part:

- **Chapters.** Greedy windows are processed in order. A part may continue the previous part's last title, and those chapters are merged.
- **Minutes and todos.** Parts are cut along chapter boundaries and run up to 4 at a time. Minutes points are concatenated and de-duplicated, and one small `overview-v1` call writes the title and overview from the chapter summaries and part points.
- **Duplicates.** Todos that say the same thing are merged, as are recap repeats in normal-length meetings: same owner with bigram similarity ≥ 0.6, or ≥ 0.8 when there is no owner.

The 35-minute fixture is about 2.5k tokens, so it takes one call per task.
