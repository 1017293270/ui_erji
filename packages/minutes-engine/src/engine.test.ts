import { describe, expect, it } from "vitest";
import { Chapter, Minutes, Todo } from "@echomind/shared";
import { people, reviewMeeting, reviewMinutes, reviewSegments, reviewTodos } from "@echomind/shared/fixtures";
import { createMinutesEngine, MinutesEngineError } from "./engine";
import { meetingContext, runPipeline } from "./pipeline";
import { LlmError } from "./provider/errors";
import { MockProvider, type MockReply } from "./provider/mock";
import type { LlmRequest } from "./provider/types";
import { goldChapters, goldMinutes, goldReplies, goldTodos } from "./testing/fixture-replies";

const NOW = () => new Date("2026-10-12T02:39:12Z");
const realIds = new Set(reviewSegments.map((s) => s.id));
const transcript = reviewMeeting.transcript!;
const ctx = meetingContext(reviewMeeting, people);

function run(replies: Record<string, MockReply[]>, extra: { maxTranscriptTokens?: number } = {}) {
  const provider = new MockProvider({ ...goldReplies, ...replies });
  return { provider, result: runPipeline(reviewMeeting, { provider, directory: people, now: NOW, ...extra }) };
}

/** Every citation in a result points at a real segment, and chapters tile the transcript. */
function expectGrounded(minutes: Minutes, todos: Todo[]) {
  expect(() => Minutes.parse(minutes)).not.toThrow();
  for (const t of todos) expect(() => Todo.parse(t)).not.toThrow();
  const cited = [...minutes.conclusions, ...minutes.decisions, ...minutes.openQuestions, ...todos].flatMap((p) => p.evidence);
  expect(cited.filter((id) => !realIds.has(id))).toEqual([]);
  const ch = minutes.chapters;
  expect(ch[0]!.firstSegmentId).toBe(reviewSegments[0]!.id);
  expect(ch[ch.length - 1]!.lastSegmentId).toBe(reviewSegments[reviewSegments.length - 1]!.id);
  const pos = (id: string) => reviewSegments.findIndex((s) => s.id === id);
  for (let i = 1; i < ch.length; i++) expect(pos(ch[i]!.firstSegmentId)).toBe(pos(ch[i - 1]!.lastSegmentId) + 1);
}

describe("runPipeline with a good answer", () => {
  it("reproduces the gold minutes and todos", async () => {
    const { provider, result } = run({});
    const { minutes, todos, usage, issues } = await result;

    expectGrounded(minutes, todos);
    expect(minutes.chapters).toEqual(reviewMinutes.chapters);
    expect(minutes.conclusions).toEqual(reviewMinutes.conclusions);
    expect(minutes.decisions).toEqual(reviewMinutes.decisions);
    expect(minutes.openQuestions).toEqual(reviewMinutes.openQuestions);
    expect(minutes.generation).toEqual({
      provider: "mock",
      model: "mock-model",
      promptVersion: "minutes-v1",
      generatedAt: "2026-10-12T10:39:12+08:00",
    });

    expect(todos.map((t) => t.id)).toEqual(["t-1", "t-2", "t-3", "t-4", "t-5", "t-6", "t-7", "t-8"]);
    for (const gold of reviewTodos) {
      const t = todos.find((x) => x.title === gold.title)!;
      expect(t, gold.title).toBeDefined();
      expect(t).toMatchObject({
        ownerMention: gold.ownerMention,
        ownerSpeakerId: gold.ownerSpeakerId,
        ownerPersonId: gold.ownerPersonId,
        ownerBasis: gold.ownerBasis,
        external: gold.external,
        dueText: gold.dueText,
        due: gold.due,
        evidence: gold.evidence,
        status: "draft",
      });
      expect(Math.abs(t.ownerConfidence - gold.ownerConfidence)).toBeLessThanOrEqual(0.1);
    }
    // Ordered by where they were first said.
    expect(todos.map((t) => t.evidence[0])).toEqual([...todos.map((t) => t.evidence[0])].sort());

    expect(usage.calls).toBe(3);
    expect(Object.keys(usage.byTask).sort()).toEqual(["chapters", "minutes", "todos"]);
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(issues).toEqual([]);
    expect(provider.calls).toHaveLength(3);
  });
});

describe("repairs", () => {
  it("fixes chapter order, overlaps, gaps and bad ids without asking again", async () => {
    const { provider, result } = run({
      chapters: [
        {
          chapters: [
            { title: "录音采集方案", summary: "采集", startSegmentId: "seg-0009", endSegmentId: "seg-0027" }, // overlaps the next one
            { title: "试点目标与数据安全", summary: "目标", startSegmentId: "seg-0001", endSegmentId: "seg-0007" }, // out of order, seg-0008 left out
            { title: "界面与交互", summary: "界面", startSegmentId: "seg-0027", endSegmentId: "seg-0039" },
            { title: "幻觉章节", summary: "不存在", startSegmentId: "seg-0100", endSegmentId: "seg-0120" }, // ids do not exist
            { title: "测试与试点安排", summary: "测试", startSegmentId: "seg-40", endSegmentId: "seg-0051" }, // sloppy id
            { title: "分工回顾", summary: "回顾", startSegmentId: "seg-0052", endSegmentId: "seg-0999" }, // end does not exist
          ],
        },
      ],
    });
    const { minutes, todos, issues } = await result;
    expect(provider.callsFor("chapters")).toHaveLength(1);
    expectGrounded(minutes, todos);
    expect(minutes.chapters.map((c) => [c.id, c.title, c.firstSegmentId, c.lastSegmentId])).toEqual(
      reviewMinutes.chapters.map((c) => [c.id, c.title, c.firstSegmentId, c.lastSegmentId]),
    );
    for (const c of minutes.chapters) expect(() => Chapter.parse(c)).not.toThrow();
    const messages = issues.filter((i) => i.task === "chapters").map((i) => i.message);
    expect(messages.join("\n")).toMatch(/幻觉章节.*都不存在/);
    expect(messages.join("\n")).toMatch(/重叠/);
    expect(messages.join("\n")).toMatch(/seg-0008.*没有归入/);
    expect(messages.join("\n")).toMatch(/seg-0999.*不存在/);
    expect(issues.every((i) => i.severity === "minor")).toBe(true);
  });

  it("drops citations to unknown segments, and points left with none", async () => {
    const { provider, result } = run({
      minutes: [
        {
          title: "需求评审",
          overview: "会议确认了试点范围。",
          conclusions: [
            { text: "试点约 20 人。", evidence: ["seg-0002", "seg-0999"] },
            { text: "编造的结论。", evidence: ["seg-0777"] },
            { text: "外放靠系统声音消回声。", evidence: "seg-0013" },
            { text: "后端再去重兜底。", evidence: ["seg-13", "seg-0013"] },
            { text: "没有依据的结论。" },
          ],
          decisions: [{ text: "默认录全部系统声音。", evidence: ["seg-0018", "seg-0015"] }],
          openQuestions: [{ text: "私有化调研没人负责。", evidence: ["seg-0049~seg-0051"] }],
        },
      ],
    });
    const { minutes, issues } = await result;
    expect(provider.callsFor("minutes")).toHaveLength(1);
    expect(minutes.conclusions).toEqual([
      { text: "试点约 20 人。", evidence: ["seg-0002"] },
      { text: "外放靠系统声音消回声。", evidence: ["seg-0013"] },
      { text: "后端再去重兜底。", evidence: ["seg-0013"] },
    ]);
    expect(minutes.decisions).toEqual([{ text: "默认录全部系统声音。", evidence: ["seg-0015", "seg-0018"] }]);
    expect(minutes.openQuestions).toEqual([{ text: "私有化调研没人负责。", evidence: ["seg-0049", "seg-0050", "seg-0051"] }]);
    const messages = issues.filter((i) => i.task === "minutes").map((i) => i.message).join("\n");
    expect(messages).toContain("seg-0999");
    expect(messages).toContain("「编造的结论。」没有有效依据");
    expect(messages).toContain("「没有依据的结论。」没有有效依据");
  });

  it("drops todos with no evidence, cites the owner line, merges the recap duplicate", async () => {
    const { provider, result } = run({
      todos: [
        {
          todos: [
            { title: "完成 Mac 双轨采集 POC", ownerMention: "我", ownerSegmentId: "seg-0022", dueText: "下周三之前", evidence: ["seg-0022", "seg-0500"] },
            { title: "没有依据的待办", ownerMention: "小王", ownerSegmentId: "seg-0600", dueText: null, evidence: [] },
            { title: "出会议详情页和待办确认页的高保真稿", ownerMention: "娜娜", ownerSegmentId: "seg-0038", dueText: "周五前", evidence: ["seg-0039"] },
            { title: "审批证书采购", ownerMention: "赵总", ownerSegmentId: "seg-0025", dueText: "这周内", evidence: ["seg-0025", "seg-0026"] },
            { title: "提供 20 个飞书测试账号", ownerMention: "孙经理", ownerSegmentId: "seg-0044", dueText: "月底前", evidence: ["seg-0044"] },
            { title: "完成 Mac 双轨采集 POC 版本", ownerMention: "小王", ownerSegmentId: "seg-0052", dueText: "下周三前", evidence: ["seg-0052"] },
          ],
        },
      ],
    });
    const { todos, issues } = await result;
    expect(provider.callsFor("todos")).toHaveLength(1);
    expect(todos.map((t) => [t.id, t.title, t.ownerPersonId, t.ownerBasis, t.due, t.evidence])).toEqual([
      ["t-1", "完成 Mac 双轨采集 POC", "p-wang", "self-claimed", "2026-10-21", ["seg-0022", "seg-0052"]],
      ["t-2", "审批证书采购", "p-zhao", "self-claimed", "2026-10-16", ["seg-0025", "seg-0026"]],
      ["t-3", "出会议详情页和待办确认页的高保真稿", "p-li", "assigned", "2026-10-16", ["seg-0038", "seg-0039"]],
      ["t-4", "提供 20 个飞书测试账号", "p-sun", "directory", "2026-10-31", ["seg-0044"]],
    ]);
    expect(todos[3]!.external).toBe(true);
    const messages = issues.filter((i) => i.task === "todos").map((i) => i.message).join("\n");
    expect(messages).toContain("「没有依据的待办」没有有效依据");
    expect(messages).toContain("seg-0500");
    expect(messages).toMatch(/是同一件事，已合并/);
  });
});

describe("retry", () => {
  it("retries once after malformed JSON, telling the model what was wrong", async () => {
    const { provider, result } = run({ chapters: [MockProvider.raw('{"chapters": [{"title": "试点'), goldChapters] });
    const { minutes, issues } = await result;
    const calls = provider.callsFor("chapters");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.user).not.toContain("上一次输出的问题");
    expect(calls[1]!.user).toContain("上一次输出的问题");
    expect(calls[1]!.user).toContain("不是有效的 JSON");
    expect(minutes.chapters).toEqual(reviewMinutes.chapters);
    expect(issues.map((i) => i.message).join("\n")).toContain("第一次输出未通过校验");
  });

  it("retries when most todos had to be dropped", async () => {
    const ungrounded = { todos: [1, 2, 3].map((n) => ({ title: `待办${n}`, ownerMention: "我", ownerSegmentId: `seg-09${n}0`, dueText: null, evidence: [`seg-08${n}0`] })) };
    const { provider, result } = run({ todos: [ungrounded, goldTodos] });
    const { todos } = await result;
    const calls = provider.callsFor("todos");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.user).toContain("没有有效的片段编号");
    expect(todos).toHaveLength(reviewTodos.length);
  });

  it("asks again with more room when the output was cut off", async () => {
    const cut = new LlmError({ kind: "invalid_json", provider: "Mock", finishReason: "length" });
    const { provider, result } = run({ chapters: [MockProvider.fail(cut), goldChapters] });
    await result;
    const [first, second] = provider.callsFor("chapters");
    expect(second!.maxTokens).toBe(first!.maxTokens! * 2);
    expect(second!.user).toContain("截断");
  });

  it("asks again about a large uncovered stretch, then repairs it if it persists", async () => {
    const holey = {
      chapters: [
        { title: "开场", summary: "", startSegmentId: "seg-0001", endSegmentId: "seg-0008" },
        { title: "测试", summary: "", startSegmentId: "seg-0040", endSegmentId: "seg-0054" },
      ],
    };
    const { provider, result } = run({ chapters: [holey] });
    const { minutes, issues } = await result;
    expect(provider.callsFor("chapters")).toHaveLength(2);
    expect(minutes.chapters.map((c) => [c.firstSegmentId, c.lastSegmentId])).toEqual([
      ["seg-0001", "seg-0039"],
      ["seg-0040", "seg-0054"],
    ]);
    expect(issues.some((i) => i.severity === "major" && i.message.includes("seg-0009–seg-0039"))).toBe(true);
  });

  it("fails clearly when the answer is unusable twice", async () => {
    const { provider, result } = run({ minutes: [MockProvider.raw("抱歉，我无法完成"), { summary: "没有要求的字段" }] });
    const err = await result.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MinutesEngineError);
    expect((err as MinutesEngineError).task).toBe("minutes");
    expect((err as MinutesEngineError).userMessage).toContain("模型连续两次生成的纪要都无法使用");
    expect((err as MinutesEngineError).issues[0]!.message).toContain("conclusions");
    expect(provider.callsFor("minutes")).toHaveLength(2);
  });

  it("does not retry provider errors like a bad key", async () => {
    const auth = new LlmError({ kind: "auth", provider: "DeepSeek", status: 401 });
    const { provider, result } = run({ chapters: [MockProvider.fail(auth)] });
    await expect(result).rejects.toBe(auth);
    expect(provider.calls).toHaveLength(1);
  });
});

describe("engine API", () => {
  it("chapters() names speakers from the engine's directory when no context is given", async () => {
    const provider = new MockProvider(goldReplies);
    const engine = createMinutesEngine({ provider, directory: people });
    const chapters = await engine.chapters(transcript);
    expect(chapters).toEqual(reviewMinutes.chapters);
    expect(provider.calls[0]!.user).toContain("[seg-0012 06:53 李娜]");
  });

  it("returns nothing for an empty transcript without calling the model", async () => {
    const provider = new MockProvider(goldReplies);
    const engine = createMinutesEngine({ provider });
    const empty = { ...transcript, segments: [] };
    expect(await engine.chapters(empty)).toEqual([]);
    expect(await engine.todos(empty, ctx)).toEqual([]);
    expect(provider.calls).toHaveLength(0);
    await expect(runPipeline({ ...reviewMeeting, transcript: empty }, { provider, directory: people })).rejects.toThrow("还没有逐字稿");
  });

  it("reports issues as they happen", async () => {
    const seen: string[] = [];
    const provider = new MockProvider({ ...goldReplies, minutes: [{ ...goldMinutes, conclusions: [{ text: "x", evidence: ["seg-0404"] }, ...goldMinutes.conclusions] }] });
    const engine = createMinutesEngine({ provider, onIssue: (i) => seen.push(i.message) });
    await engine.minutes(transcript, reviewMinutes.chapters, ctx);
    expect(seen.join()).toContain("seg-0404");
  });
});

describe("long meetings", () => {
  /** Answers for whatever part of the transcript the prompt carries. */
  const idsIn = (req: LlmRequest) => [...req.user.matchAll(/^\[(seg-\d{4}) /gm)].map((m) => m[1]!);

  const replies: Record<string, MockReply[]> = {
    chapters: [
      (req: LlmRequest) => {
        const ids = idsIn(req);
        const mid = Math.floor(ids.length / 2);
        const carried = /上一部分最后一章的标题是「(.+?)」/.exec(req.user)?.[1];
        return {
          chapters: [
            { title: carried ?? `话题 ${ids[0]}`, summary: `从 ${ids[0]} 开始`, startSegmentId: ids[0], endSegmentId: ids[mid - 1] },
            { title: `话题 ${ids[mid]}`, summary: `从 ${ids[mid]} 开始`, startSegmentId: ids[mid], endSegmentId: ids[ids.length - 1] },
          ],
        };
      },
    ],
    minutes: [
      (req: LlmRequest) => {
        const ids = idsIn(req);
        return {
          title: `部分 ${ids[0]}`,
          overview: `${ids[0]} 到 ${ids[ids.length - 1]}`,
          conclusions: [{ text: `结论 ${ids[0]}`, evidence: [ids[0]] }],
          decisions: [],
          openQuestions: [{ text: `问题 ${ids[1]}`, evidence: [ids[1], "seg-9999"] }],
        };
      },
    ],
    todos: [
      (req: LlmRequest, call: number) => {
        const ids = idsIn(req);
        const titles = ["准备设备清单", "调研私有化成本", "对齐试点名单", "采购签名证书", "整理评测集", "出高保真设计稿"];
        return { todos: [{ title: titles[call % titles.length], ownerMention: null, ownerSegmentId: ids[0], dueText: null, evidence: [ids[0]] }] };
      },
    ],
    overview: [{ title: "长会议纪要", overview: "整场会议的概述。" }],
  };

  it("splits by the token budget, then merges into one grounded result", async () => {
    const provider = new MockProvider(replies);
    const { minutes, todos, usage } = await runPipeline(reviewMeeting, { provider, directory: people, now: NOW, maxTranscriptTokens: 700 });
    const chapterCalls = provider.callsFor("chapters");
    const parts = chapterCalls.length;
    expect(parts).toBeGreaterThanOrEqual(3);

    // Every segment went to the model exactly once per task.
    expect(chapterCalls.flatMap(idsIn)).toEqual(reviewSegments.map((s) => s.id));
    expect(provider.callsFor("minutes").flatMap(idsIn)).toEqual(reviewSegments.map((s) => s.id));
    expect(provider.callsFor("todos").flatMap(idsIn)).toEqual(reviewSegments.map((s) => s.id));

    expectGrounded(minutes, todos);
    // Each part opens by continuing the previous part's last topic, so those merge.
    expect(minutes.chapters).toHaveLength(parts + 1);
    expect(minutes.chapters.map((c) => c.id)).toEqual(minutes.chapters.map((_, i) => `ch-${i + 1}`));
    expect(chapterCalls[1]!.user).toMatch(/第 2\/\d+ 部分/);

    expect(provider.callsFor("overview")).toHaveLength(1);
    expect(minutes.title).toBe("长会议纪要");
    expect(minutes.overview).toBe("整场会议的概述。");
    expect(minutes.conclusions.length).toBe(provider.callsFor("minutes").length);
    expect(todos.length).toBe(provider.callsFor("todos").length);
    expect(usage.byTask.overview?.calls).toBe(1);
  });
});
