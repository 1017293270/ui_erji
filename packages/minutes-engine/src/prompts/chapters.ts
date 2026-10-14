import { exampleJson, JSON_ONLY, marker, ROLE, TRANSCRIPT_FORMAT } from "./common";

export const CHAPTERS_PROMPT_VERSION = "chapters-v1";

const EXAMPLE = {
  chapters: [
    {
      title: "项目背景与目标",
      summary: "主持人说明本次会议的范围；张伟提出月底前完成上线，需要同时支持两个平台。",
      startSegmentId: "seg-0001",
      endSegmentId: "seg-0011",
    },
    {
      title: "技术方案讨论",
      summary: "刘芳介绍了数据同步方案，大家同意先做离线版本，实时同步放到下一期。",
      startSegmentId: "seg-0012",
      endSegmentId: "seg-0030",
    },
  ],
};

export const CHAPTERS_SYSTEM = [
  marker("chapters", CHAPTERS_PROMPT_VERSION),
  ROLE,
  TRANSCRIPT_FORMAT,
  "",
  "## 任务",
  "按话题把整场会议切成若干章节，给每章起标题、写摘要。",
  "",
  "## 规则",
  "1. 章节按时间顺序排列，首尾相接、不重叠、不遗漏：第一章从第一个片段开始，最后一章到最后一个片段结束，每一章的 startSegmentId 紧接上一章 endSegmentId 的下一个片段。",
  "2. 章节数量跟着话题走：一般每 5–10 分钟一章，30 分钟左右的会议通常 3–6 章。不要把一两句话单独切成一章；开场寒暄并入第一章；会末的总结或分工复述可以单独成章。",
  "3. title：这一段的话题，名词短语，不超过 12 个字。",
  "4. summary：1–2 句话，写清这一段讨论了什么、定了什么、谁负责什么。提到人用逐字稿里的说话人名字。只写这一段里说过的内容，不推测。",
  "5. startSegmentId、endSegmentId 必须是逐字稿里真实存在的片段编号。",
  "",
  "## 输出",
  JSON_ONLY,
  exampleJson(EXAMPLE),
].join("\n");

export interface ChaptersPromptInput {
  speakers: string;
  transcript: string;
  segmentCount: number;
  firstId: string;
  lastId: string;
  duration: string;
  /** Long meetings are cut into parts: which part this is, and the previous part's last chapter title. */
  part?: { index: number; total: number; previousTitle?: string };
}

export function chaptersUser(input: ChaptersPromptInput): string {
  const lines = [
    input.part
      ? `这是一场长会议的第 ${input.part.index}/${input.part.total} 部分，本部分共 ${input.segmentCount} 个片段，从 ${input.firstId} 到 ${input.lastId}。只给本部分切章节，第一章从 ${input.firstId} 开始，最后一章到 ${input.lastId} 结束。` +
        (input.part.previousTitle ? `上一部分最后一章的标题是「${input.part.previousTitle}」；如果本部分开头延续的是同一个话题，第一章就用完全相同的标题。` : "")
      : `会议时长 ${input.duration}，共 ${input.segmentCount} 个片段，从 ${input.firstId} 到 ${input.lastId}。`,
    "",
    "## 说话人",
    input.speakers,
    "",
    "## 逐字稿",
    input.transcript,
    "",
    "请按要求输出 JSON。",
  ];
  return lines.join("\n");
}
