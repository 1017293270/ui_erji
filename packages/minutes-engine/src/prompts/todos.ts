import { exampleJson, JSON_ONLY, marker, ROLE, TRANSCRIPT_FORMAT } from "./common";

export const TODOS_PROMPT_VERSION = "todos-v1";

const EXAMPLE = {
  todos: [
    {
      title: "整理竞品功能对比表",
      detail: "覆盖三家主要竞品的导出和权限功能。",
      ownerMention: "小张",
      ownerSegmentId: "seg-0031",
      dueText: "下周二前",
      evidence: ["seg-0031", "seg-0032"],
    },
    {
      title: "确认服务器采购预算",
      detail: null,
      ownerMention: "我",
      ownerSegmentId: "seg-0040",
      dueText: "这周内",
      evidence: ["seg-0040"],
    },
    {
      title: "调研私有化部署的硬件成本",
      detail: null,
      ownerMention: null,
      ownerSegmentId: "seg-0052",
      dueText: null,
      evidence: ["seg-0052", "seg-0054"],
    },
  ],
};

export const TODOS_SYSTEM = [
  marker("todos", TODOS_PROMPT_VERSION),
  ROLE,
  TRANSCRIPT_FORMAT,
  "",
  "## 任务",
  "找出会上明确布置或认领的待办事项。每条待办的字段：",
  "- title：要做的事，动宾短语，不超过 25 个字，例如「完成 Mac 采集 POC」。",
  "- detail：范围、标准等补充说明；没有就填 null。",
  "- ownerMention：原话里对负责人的称呼，原样照抄，例如「小王」「娜娜」「赵总」「孙经理」。说话人自己认领（「我来」「我这边做」「名单我来对」）时填「我」。会上没人负责时填 null。不要把称呼换成全名，不要猜。",
  "- ownerSegmentId：确定负责人的那一句的片段编号：点名布置的那句，或自己认领的那句。没人负责时填提出这件事的那句。",
  "- dueText：原话里的完成时间，原样照抄，例如「下周三之前」「周五前」「这周内」「月底前」；没说就填 null。不要换算成具体日期。",
  "- evidence：支撑这条待办的片段编号（布置、认领、答应、会末复述），1–4 个。",
  "",
  "## 规则",
  "1. 只提取会上确实要有人去做的事：被点名布置的、有人主动认领的、外部人员答应提供的。泛泛的想法和「之后再细排」的事不算。",
  "2. 会上明确需要做、但还没有人负责的事（如「谁有空先看一下」「我回头找人」）也要列出，ownerMention 填 null。",
  "3. 被点名的人当场答应（「好的」「我这周内批掉」）：ownerMention 填点名时的称呼，ownerSegmentId 填点名的那句，答应的那句放进 evidence。",
  "4. 一句话里有两件事或两个负责人时，拆成两条。",
  "5. 同一件事被说了多次（例如会末复述分工），只算一条，把相关片段都放进 evidence。",
  "6. 片段编号必须是逐字稿里真实存在的。",
  "",
  "## 输出",
  JSON_ONLY,
  exampleJson(EXAMPLE),
].join("\n");

export interface TodosPromptInput {
  date: string;
  participants: string;
  speakers: string;
  transcript: string;
  part?: { index: number; total: number };
}

export function todosUser(input: TodosPromptInput): string {
  return [
    `会议日期：${input.date}`,
    input.part ? `这是一场长会议的第 ${input.part.index}/${input.part.total} 部分，只提取这一部分里出现的待办。` : "",
    "",
    "## 参会人（称呼仅供参考，ownerMention 仍然照抄原话）",
    input.participants || "（无）",
    "",
    "## 说话人",
    input.speakers,
    "",
    "## 逐字稿",
    input.transcript,
    "",
    "请按要求输出 JSON。",
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
}
