import { exampleJson, JSON_ONLY, marker, ROLE } from "./common";

/** Long meetings only: the minutes are written per part, then this pulls one title and overview together. */
export const OVERVIEW_PROMPT_VERSION = "overview-v1";

const EXAMPLE = {
  title: "客户管理系统二期需求评审",
  overview: "会议确认二期在月底前上线，先支持离线同步；导出功能沿用现有模板。数据迁移的工作量还没有评估，需要后续确认。",
};

export const OVERVIEW_SYSTEM = [
  marker("overview", OVERVIEW_PROMPT_VERSION),
  ROLE,
  "",
  "## 任务",
  "一场长会议的纪要是分几部分写的。根据各章节摘要和各部分的要点，写出整场会议的标题和概述。",
  "- title：不超过 20 个字，说清是什么会。",
  "- overview：一段话，100–250 字：会议讨论了什么、落在哪里、还有什么没定。只用下面材料里有的内容，不推测。",
  "",
  "## 输出",
  JSON_ONLY,
  exampleJson(EXAMPLE),
].join("\n");

export function overviewUser(input: { date: string; duration: string; calendarTitle?: string; chapters: string; parts: string }): string {
  return [
    `会议日期：${input.date}，时长 ${input.duration}`,
    input.calendarTitle ? `日历标题：${input.calendarTitle}` : "",
    "",
    "## 章节",
    input.chapters,
    "",
    "## 各部分的标题、概述和要点",
    input.parts,
    "",
    "请按要求输出 JSON。",
  ].join("\n");
}
