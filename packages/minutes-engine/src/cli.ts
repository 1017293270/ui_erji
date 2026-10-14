/**
 * Runs the minutes pipeline from the terminal and prints a readable summary.
 *
 *   pnpm --filter @echomind/minutes-engine minutes [--fixture | <transcript.json>] [--out result.json] [--mock]
 *
 * Runs on Node 24 through tsx (Node's own type stripping cannot resolve the
 * extensionless imports the workspace packages use).
 */
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Meeting, Person, Transcript, type Todo } from "@echomind/shared";
import { people as fixturePeople, reviewMeeting } from "@echomind/shared/fixtures";
import { MinutesEngineError, shanghaiIso } from "./engine";
import { runPipeline, type PipelineResult } from "./pipeline";
import { DeepSeekProvider } from "./provider/deepseek";
import { LlmError, MissingApiKeyError } from "./provider/errors";
import { MockProvider } from "./provider/mock";
import type { LlmProvider } from "./provider/types";
import { renderDate, renderDuration, stamp } from "./prompts/render";
import { goldReplies } from "./testing/fixture-replies";

const HELP = `用法：
  pnpm --filter @echomind/minutes-engine minutes [--fixture | <会议.json>] [选项]

输入：
  --fixture            使用内置的示例会议（默认）
  <会议.json>          一场会议（含 transcript 的 Meeting）或一份逐字稿（Transcript）的 JSON 文件

选项：
  --out <文件>         把完整结果（纪要、待办、用量、修复记录）写成 JSON
  --people <文件>      通讯录 JSON（Person 数组），默认用示例数据里的通讯录
  --date <时间>        逐字稿文件的会议开始时间，如 2026-10-12T10:00:00+08:00（默认现在）
  --mock               不调用 DeepSeek，用示例会议的标准答案演示输出格式
  -h, --help           显示帮助

环境变量：
  DEEPSEEK_API_KEY     必填，在 https://platform.deepseek.com/api_keys 创建
  DEEPSEEK_MODEL       默认 deepseek-flash
  DEEPSEEK_BASE_URL    默认 https://api.deepseek.com
  DEEPSEEK_THINKING    设为 1 开启思考模式（默认关闭）
  DEEPSEEK_TIMEOUT_MS  单次请求超时，默认 300000`;

const BASIS: Record<Todo["ownerBasis"], string> = {
  "self-claimed": "本人认领",
  assigned: "点名指派",
  directory: "通讯录匹配",
  unresolved: "待确认",
};

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    options: {
      fixture: { type: "boolean" },
      out: { type: "string", short: "o" },
      people: { type: "string" },
      date: { type: "string" },
      mock: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  // pnpm runs scripts in the package directory; resolve paths from where the user typed the command.
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const file = values.fixture ? undefined : positionals[0];
  const directory = values.people ? Person.array().parse(await readJson(resolve(cwd, values.people))) : fixturePeople;
  const meeting = file ? await loadMeeting(resolve(cwd, file), values.date) : reviewMeeting;

  let provider: LlmProvider;
  if (values.mock) {
    if (file) console.error("提示：--mock 只有示例会议的标准答案，对其他文件的结果没有意义。");
    provider = new MockProvider(goldReplies, { name: "mock", model: "示例标准答案" });
  } else {
    try {
      provider = DeepSeekProvider.fromEnv();
    } catch (err) {
      if (!(err instanceof MissingApiKeyError)) throw err;
      console.error(
        [
          "未设置 DEEPSEEK_API_KEY，无法调用 DeepSeek 生成纪要。",
          "",
          "1. 在 https://platform.deepseek.com/api_keys 创建 API Key（需要先充值）；",
          "2. 在当前终端设置：export DEEPSEEK_API_KEY=sk-你的密钥",
          "3. 重新运行：pnpm --filter @echomind/minutes-engine minutes --fixture",
          "",
          "想先看看输出格式，可以加 --mock 用示例会议的标准答案演示，不调用模型。",
        ].join("\n"),
      );
      return 2;
    }
  }

  console.error(`正在用 ${provider.name} / ${provider.model} 生成「${meeting.title}」的纪要…`);
  const started = Date.now();
  const result = await runPipeline(meeting, {
    provider,
    directory,
    onProgress: (step, state) => {
      const label = { chapters: "切分章节", minutes: "撰写纪要", todos: "提取待办" }[step];
      if (state === "done") console.error(`  ✓ ${label}（${((Date.now() - started) / 1000).toFixed(1)} 秒）`);
    },
  });
  console.log(summary(meeting, result, directory, Date.now() - started));

  if (values.out) {
    const out = resolve(cwd, values.out);
    await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
    console.error(`完整结果已写入 ${out}`);
  }
  return 0;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new UsageError(`读不了 ${path}：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** A Meeting with a transcript, or a bare Transcript wrapped into one. */
async function loadMeeting(path: string, date?: string): Promise<Meeting> {
  const json = (await readJson(path)) as Record<string, unknown>;
  if (json && typeof json === "object" && "transcript" in json) return Meeting.parse(json);
  const parsed = Transcript.safeParse(json);
  if (!parsed.success) throw new UsageError(`${path} 既不是会议（Meeting）也不是逐字稿（Transcript）的 JSON。`);
  const t = parsed.data;
  const ids = [...new Set(t.speakers.map((s) => s.personId).filter((id): id is string => !!id))];
  return Meeting.parse({
    id: t.meetingId,
    title: basename(path).replace(/\.json$/i, ""),
    source: "other",
    status: "review",
    startedAt: date ?? shanghaiIso(new Date()),
    durationMs: t.segments.at(-1)?.end ?? 0,
    recorderId: t.speakers.find((s) => s.track === "mic")?.personId ?? "",
    participantIds: ids,
    transcript: t,
  });
}

function summary(meeting: Meeting, r: PipelineResult, directory: Person[], ms: number): string {
  const m = r.minutes;
  const byId = new Map(directory.map((p) => [p.id, p]));
  const speakers = new Map(meeting.transcript!.speakers.map((s) => [s.id, s]));
  const cite = (ids: string[]) => `［${ids.join(", ")}］`;
  const out: string[] = [];
  const push = (...lines: string[]) => out.push(...lines);

  push(
    "",
    m.title,
    `${renderDate(meeting.startedAt)} · ${renderDuration(meeting.durationMs)} · ${m.generation.provider} / ${m.generation.model} · ${m.generation.promptVersion}`,
    "",
    "概述",
    `  ${m.overview}`,
    "",
    `章节（${m.chapters.length}）`,
  );
  m.chapters.forEach((c, i) => {
    push(`  ${i + 1}. ${stamp(c.start)}–${stamp(c.end)}  ${c.title}  ［${c.firstSegmentId}–${c.lastSegmentId}］`);
    if (c.summary) push(`     ${c.summary}`);
  });
  for (const [label, points] of [
    ["结论", m.conclusions],
    ["决定", m.decisions],
    ["待确认问题", m.openQuestions],
  ] as const) {
    push("", `${label}（${points.length}）`);
    if (!points.length) push("  （无）");
    for (const p of points) push(`  · ${p.text} ${cite(p.evidence)}`);
  }

  push("", `待办（${r.todos.length}）`);
  for (const t of r.todos) {
    const person = t.ownerPersonId ? byId.get(t.ownerPersonId) : undefined;
    const speaker = t.ownerSpeakerId ? speakers.get(t.ownerSpeakerId) : undefined;
    const who = person
      ? `${person.name}${person.external ? `（外部${person.company ? `：${person.company}` : ""}，由记录人跟进）` : ""}`
      : speaker
        ? `${speaker.label}（未识别身份）`
        : "未定";
    const how = `${BASIS[t.ownerBasis]}${t.ownerMention ? `「${t.ownerMention}」` : ""}${speaker ? `（${speaker.label}）` : ""}`;
    push(
      `  ${t.id.padEnd(4)} ${t.title}`,
      `       负责人：${who} · ${how} · 置信 ${t.ownerConfidence.toFixed(2)}`,
      `       截止：${t.due ? `${t.due}（${t.dueText}）` : t.dueText ? `未能换算（${t.dueText}）` : "未说"}`,
      `       依据：${t.evidence.join(", ")}`,
    );
    if (t.detail) push(`       说明：${t.detail}`);
  }

  if (r.issues.length) {
    push("", `校验与修复（${r.issues.length}）`);
    for (const i of r.issues) push(`  [${i.task}${i.severity === "minor" ? "" : ` · ${i.severity}`}] ${i.message}`);
  }

  const u = r.usage;
  const n = (x: number) => x.toLocaleString("en-US");
  push(
    "",
    `用量：${u.calls} 次调用 · 输入 ${n(u.inputTokens)} tokens（缓存命中 ${n(u.cachedInputTokens)}）· 输出 ${n(u.outputTokens)} tokens` +
      `${u.reasoningTokens ? `（其中思考 ${n(u.reasoningTokens)}）` : ""} · 用时 ${(ms / 1000).toFixed(1)} 秒`,
    "",
  );
  return out.join("\n");
}

class UsageError extends Error {}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof LlmError) {
      console.error(`生成失败：${err.userMessage}${err.detail ? `\n详情：${err.detail}` : ""}`);
    } else if (err instanceof MinutesEngineError) {
      console.error(`生成失败：${err.userMessage}`);
      for (const i of err.issues) console.error(`  - ${i.message}`);
    } else if (err instanceof UsageError) {
      console.error(err.message);
    } else if (err instanceof Error && err.name === "ZodError") {
      console.error(`输入文件不符合数据格式：${err.message}`);
    } else {
      console.error(`生成失败：${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
  },
);
