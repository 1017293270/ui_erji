import { describe, expect, it } from "vitest";
import { people, reviewMeeting, reviewSegments, reviewSpeakers } from "@echomind/shared/fixtures";
import { meetingContext } from "../pipeline";
import { MockProvider, TASK_MARKER } from "../provider/mock";
import { goldReplies } from "../testing/fixture-replies";
import { estimateTokens } from "../tokens";
import { CHAPTERS_SYSTEM } from "./chapters";
import { MINUTES_SYSTEM } from "./minutes";
import { OVERVIEW_SYSTEM } from "./overview";
import { peopleById, renderTranscript, stamp } from "./render";
import { TODOS_SYSTEM } from "./todos";
import { runPipeline } from "../pipeline";

const rendered = renderTranscript(reviewSegments, reviewSpeakers, peopleById(people));
const lines = rendered.split("\n");

describe("rendered transcript", () => {
  it("has one line per segment, every id, in order", () => {
    expect(lines).toHaveLength(reviewSegments.length);
    reviewSegments.forEach((seg, i) => {
      expect(lines[i]!.startsWith(`[${seg.id} `)).toBe(true);
      expect(rendered).toContain(seg.id);
    });
    for (const line of lines) expect(line).toMatch(/^\[seg-\d{4} \d{2}:\d{2} [^\]]+\] \S/);
  });

  it("uses names for resolved speakers and the label for the unnamed one", () => {
    expect(lines[11]).toBe("[seg-0012 06:53 李娜] 那如果用户开的是外放，不戴耳机呢？麦克风会不会把对方的声音也录进去？");
    for (const name of ["陈一鸣", "王磊", "李娜", "赵建国", "说话人 5"]) expect(rendered).toContain(`${name}]`);
    expect(lines[18]).toMatch(/^\[seg-0019 10:53 说话人 5\] /);
    expect(rendered).not.toContain("说话人 1]");
  });

  it("formats times past the hour", () => {
    expect(stamp(5_000)).toBe("00:05");
    expect(stamp(35 * 60_000 + 13_000)).toBe("35:13");
    expect(stamp(3600_000 + 62_000)).toBe("1:01:02");
  });

  it("fits the fixture in one call per task", () => {
    // ~2.5k Chinese characters: far below the 32k-token default budget.
    expect(estimateTokens(rendered)).toBeLessThan(4000);
  });
});

describe("system prompts", () => {
  it.each([
    ["chapters", CHAPTERS_SYSTEM],
    ["minutes", MINUTES_SYSTEM],
    ["todos", TODOS_SYSTEM],
    ["overview", OVERVIEW_SYSTEM],
  ])("%s: marked, versioned, asks for JSON with an example", (task, system) => {
    expect(TASK_MARKER.exec(system)?.[1]).toBe(task);
    expect(system).toContain(`${task}-v1`);
    // DeepSeek JSON mode needs the word json and an example in the prompt.
    expect(system.toLowerCase()).toContain("json");
    const example = system.slice(system.lastIndexOf("JSON 格式示例：") + "JSON 格式示例：".length);
    expect(() => JSON.parse(example)).not.toThrow();
  });
});

describe("user prompts sent for the fixture", () => {
  it("carry the whole transcript, speakers, participants and the meeting date", async () => {
    const provider = new MockProvider(goldReplies);
    await runPipeline(reviewMeeting, { provider, directory: people });
    expect(provider.calls.map((c) => c.task).sort()).toEqual(["chapters", "minutes", "todos"]);
    for (const call of provider.calls) {
      expect(call.user).toContain(rendered);
      expect(call.user).toContain("说话人 2：王磊");
      expect(call.user).toContain("说话人 5：未识别身份");
      expect(call.user).toMatch(/json/i);
    }
    const todos = provider.callsFor("todos")[0]!.user;
    expect(todos).toContain("会议日期：2026-10-12（周一）");
    expect(todos).toContain("王磊（研发部 后端工程师；也叫：小王、磊哥）");
    // Outside contacts not in the meeting are left to the resolver, not the prompt.
    expect(todos).not.toContain("孙浩");
    const minutes = provider.callsFor("minutes")[0]!.user;
    expect(minutes).toContain("日历标题：EchoMind 桌面端二期需求评审");
    expect(minutes).toContain("1. 试点目标与数据安全（seg-0001–seg-0008，00:05–04:10）");
    expect(meetingContext(reviewMeeting, people).participants.map((p) => p.id)).toEqual(reviewMeeting.participantIds);
  });
});
