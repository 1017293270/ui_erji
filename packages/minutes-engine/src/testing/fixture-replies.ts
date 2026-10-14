import { reviewMinutes, reviewTodos } from "@echomind/shared/fixtures";
import type { MockReply } from "../provider/mock";

/**
 * What a good model answer for the fixture meeting looks like, derived from
 * the hand-written gold minutes and todos: the shape the prompts ask for,
 * before code resolves owners and dates. Used by tests and `minutes --mock`.
 */

/** The line that assigned or claimed each gold todo. */
const OWNER_LINE: Record<string, string> = {
  "t-101": "seg-0022", // Mac 这边我来做
  "t-102": "seg-0038", // 娜娜你周五前…
  "t-103": "seg-0042", // 婷婷，那这个设备测试矩阵…
  "t-104": "seg-0025", // 赵总您这边批一下
  "t-105": "seg-0025", // 我把清单发您
  "t-106": "seg-0046", // 名单我来跟孙经理对
  "t-107": "seg-0044", // 孙经理说月底前给到
  "t-108": "seg-0049", // 谁有空先看一下
};

export const goldChapters = {
  chapters: reviewMinutes.chapters.map((c) => ({
    title: c.title,
    summary: c.summary,
    startSegmentId: c.firstSegmentId,
    endSegmentId: c.lastSegmentId,
  })),
};

export const goldMinutes = {
  title: reviewMinutes.title,
  overview: reviewMinutes.overview,
  conclusions: reviewMinutes.conclusions,
  decisions: reviewMinutes.decisions,
  openQuestions: reviewMinutes.openQuestions,
};

export const goldTodos = {
  todos: reviewTodos.map((t) => ({
    title: t.title,
    detail: t.detail ?? null,
    ownerMention: t.ownerMention,
    ownerSegmentId: OWNER_LINE[t.id] ?? t.evidence[0],
    dueText: t.dueText,
    evidence: t.evidence,
  })),
};

export const goldReplies: Record<string, MockReply[]> = {
  chapters: [goldChapters],
  minutes: [goldMinutes],
  todos: [goldTodos],
};
