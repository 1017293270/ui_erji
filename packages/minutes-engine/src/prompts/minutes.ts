import { exampleJson, JSON_ONLY, marker, ROLE, TRANSCRIPT_FORMAT } from "./common";

export const MINUTES_PROMPT_VERSION = "minutes-v1";

const EXAMPLE = {
  title: "客户管理系统二期需求评审",
  overview:
    "会议确认二期在月底前上线，先支持离线同步；导出功能沿用现有模板。数据迁移的工作量还没有评估，需要后续确认。",
  conclusions: [
    { text: "二期月底前上线，Windows 和 Mac 都要支持。", evidence: ["seg-0003", "seg-0005"] },
    { text: "现有导出模板可以复用，不需要重新设计。", evidence: ["seg-0021"] },
  ],
  decisions: [{ text: "先做离线同步，实时同步放到三期。", evidence: ["seg-0016", "seg-0018"] }],
  openQuestions: [{ text: "历史数据迁移的工作量还没有评估。", evidence: ["seg-0040", "seg-0041"] }],
};

export const MINUTES_SYSTEM = [
  marker("minutes", MINUTES_PROMPT_VERSION),
  ROLE,
  TRANSCRIPT_FORMAT,
  "",
  "## 任务",
  "根据逐字稿和已经切好的章节写会议纪要，字段如下：",
  "- title：会议标题，不超过 20 个字，说清是什么会。给了日历标题时可以沿用，或改得更具体。",
  "- overview：一段话，80–200 字：会议讨论了什么、落在哪里、还有什么没定。",
  "- conclusions：会上形成的共识、确认的事实、方案要点。",
  "- decisions：明确拍板的决定（如「就这么定」「我们定了用……」「默认……」）。写进 decisions 的内容不要在 conclusions 里重复。",
  "- openQuestions：没有结论、没人负责、存在风险或还需验证的问题。",
  "conclusions、decisions、openQuestions 的每一条都是 {\"text\": 一句话, \"evidence\": [片段编号…]}。",
  "",
  "## 规则",
  "1. 依据：每一条都必须在 evidence 里列出直接支撑它的片段编号（1–4 个），编号必须是逐字稿里真实存在的。找不到依据的内容不要写。",
  "2. 忠于原话：只写会上说过的内容，不推测、不补充、不拔高；数字、时间、产品名照原话。",
  "3. 待办（谁在什么时候前做什么）不写进纪要，另有任务专门提取；但没人负责的事项可以写进 openQuestions。",
  "4. 每条一句话，不超过 60 个字，用书面语；提到人用姓名，未识别的说话人照写标签。",
  "5. 数量：conclusions 2–6 条，decisions 0–6 条，openQuestions 0–5 条；没有就给空数组 []。",
  "",
  "## 输出",
  JSON_ONLY,
  exampleJson(EXAMPLE),
].join("\n");

export interface MinutesPromptInput {
  date: string;
  duration: string;
  calendarTitle?: string;
  participants: string;
  speakers: string;
  chapters: string;
  transcript: string;
  /** Long meetings: this call covers only some chapters. */
  part?: { index: number; total: number };
}

export function minutesUser(input: MinutesPromptInput): string {
  return [
    `会议日期：${input.date}，时长 ${input.duration}`,
    input.calendarTitle ? `日历标题：${input.calendarTitle}` : "",
    input.part
      ? `这是一场长会议的第 ${input.part.index}/${input.part.total} 部分，只根据下面这部分逐字稿写纪要；title 和 overview 只概括这一部分。`
      : "",
    "",
    "## 参会人",
    input.participants || "（无）",
    "",
    "## 说话人",
    input.speakers,
    "",
    "## 章节",
    input.chapters,
    "",
    "## 逐字稿",
    input.transcript,
    "",
    "请按要求输出 JSON。",
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
}
