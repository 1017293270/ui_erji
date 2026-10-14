import type { Meeting, Person, Todo } from "../meeting";
import { reviewMeeting } from "./review-meeting";

export { reviewMeeting, reviewMinutes, reviewSegments, reviewSpeakers, reviewTodos } from "./review-meeting";

/** Sample data is pinned to this moment so relative dates read the same every day. */
export const SAMPLE_NOW = "2026-10-13T09:40:00+08:00";

/** The signed-in user in the sample data. */
export const SAMPLE_ME = "p-chen";

export const people: Person[] = [
  { id: "p-chen", name: "陈一鸣", department: "产品部", title: "产品负责人", aliases: ["一鸣"], external: false },
  { id: "p-wang", name: "王磊", department: "研发部", title: "后端工程师", aliases: ["小王", "磊哥"], external: false },
  { id: "p-li", name: "李娜", department: "设计部", title: "设计师", aliases: ["娜娜"], external: false },
  { id: "p-zhao", name: "赵建国", department: "管理层", title: "CEO", aliases: ["赵总", "老赵"], external: false },
  { id: "p-zhou", name: "周婷", department: "研发部", title: "测试工程师", aliases: ["婷婷"], external: false },
  { id: "p-liu", name: "刘洋", department: "研发部", title: "前端工程师", aliases: ["小刘"], external: false },
  { id: "p-he", name: "何静", department: "销售部", title: "销售经理", aliases: ["静姐"], external: false },
  { id: "p-sun", name: "孙浩", title: "IT 经理", company: "蓝海物流", aliases: ["孙经理"], external: true },
];

const summary = (m: Omit<Meeting, "marks"> & { marks?: number[] }): Meeting => ({ marks: [], ...m });

/** Recent meetings, newest first. Only the review meeting carries a full transcript. */
export const meetings: Meeting[] = [
  summary({
    id: "m-1013-sales",
    title: "销售周会：华东区线索复盘",
    source: "tencent",
    status: "transcribing",
    startedAt: "2026-10-13T09:00:00+08:00",
    durationMs: 32 * 60000,
    recorderId: "p-chen",
    participantIds: ["p-chen", "p-he", "p-zhao"],
  }),
  reviewMeeting,
  summary({
    id: "m-1010-design",
    title: "设计评审：录音浮窗与托盘",
    source: "feishu",
    status: "pushed",
    startedAt: "2026-10-10T15:30:00+08:00",
    durationMs: 48 * 60000,
    recorderId: "p-chen",
    participantIds: ["p-chen", "p-li", "p-liu"],
  }),
  summary({
    id: "m-1009-pilot",
    title: "蓝海物流试点启动会",
    source: "tencent",
    status: "pushed",
    startedAt: "2026-10-09T14:00:00+08:00",
    durationMs: 64 * 60000,
    recorderId: "p-chen",
    participantIds: ["p-chen", "p-zhao", "p-he", "p-sun"],
  }),
  summary({
    id: "m-1008-voiceprint",
    title: "声纹方案技术讨论",
    source: "offline",
    status: "ready",
    startedAt: "2026-10-08T11:00:00+08:00",
    durationMs: 41 * 60000,
    recorderId: "p-chen",
    participantIds: ["p-chen", "p-wang", "p-zhou"],
  }),
  summary({
    id: "m-1007-visit",
    title: "客户回访：华南区经销商",
    source: "tencent",
    status: "failed",
    startedAt: "2026-10-07T16:00:00+08:00",
    durationMs: 27 * 60000,
    recorderId: "p-chen",
    participantIds: ["p-chen", "p-he"],
  }),
  summary({
    id: "m-1005-weekly",
    title: "研发周会",
    source: "feishu",
    status: "pushed",
    startedAt: "2026-10-05T10:00:00+08:00",
    durationMs: 52 * 60000,
    recorderId: "p-chen",
    participantIds: ["p-chen", "p-wang", "p-li", "p-zhou", "p-liu"],
  }),
];

const pushed = (t: Omit<Todo, "ownerMention" | "ownerSpeakerId" | "ownerBasis" | "ownerConfidence" | "external" | "dueText"> & Partial<Todo>): Todo => ({
  ownerMention: null,
  ownerSpeakerId: null,
  ownerBasis: "assigned",
  ownerConfidence: 0.9,
  external: false,
  dueText: null,
  ...t,
});

/** Todos from earlier meetings, already in Feishu. Keyed by the meeting they came from. */
export const earlierTodos: (Todo & { meetingId: string })[] = [
  { meetingId: "m-1010-design", ...pushed({ id: "t-081", title: "录音浮窗加上「标记重点」按钮", ownerPersonId: "p-liu", due: "2026-10-14", evidence: ["seg-0031"], status: "pushed", feishuTaskId: "ft-81" }) },
  { meetingId: "m-1010-design", ...pushed({ id: "t-082", title: "托盘图标出录制中 / 空闲两套", ownerPersonId: "p-li", due: "2026-10-13", evidence: ["seg-0044"], status: "done", feishuTaskId: "ft-82" }) },
  { meetingId: "m-1009-pilot", ...pushed({ id: "t-071", title: "准备试点合同与数据处理协议", ownerPersonId: "p-he", due: "2026-10-12", evidence: ["seg-0058"], status: "delayed", feishuTaskId: "ft-71" }) },
  { meetingId: "m-1009-pilot", ...pushed({ id: "t-072", title: "确认客户内网能否访问我们的服务", ownerPersonId: "p-sun", external: true, due: "2026-10-15", evidence: ["seg-0063"], status: "pushed" }) },
  { meetingId: "m-1009-pilot", ...pushed({ id: "t-073", title: "给客户演示录音与纪要流程", ownerPersonId: "p-chen", due: "2026-10-10", evidence: ["seg-0070"], status: "done", feishuTaskId: "ft-73" }) },
  { meetingId: "m-1008-voiceprint", ...pushed({ id: "t-061", title: "声纹阈值在线上 / 线下两种信道分别测一轮", ownerPersonId: "p-wang", due: "2026-10-16", evidence: ["seg-0022"], status: "pushed", feishuTaskId: "ft-61" }) },
  { meetingId: "m-1008-voiceprint", ...pushed({ id: "t-062", title: "写声纹同意卡片的文案并过法务", ownerPersonId: "p-chen", due: "2026-10-12", evidence: ["seg-0035"], status: "blocked", feishuTaskId: "ft-62" }) },
  { meetingId: "m-1005-weekly", ...pushed({ id: "t-051", title: "搭好 monorepo 与桌面端骨架", ownerPersonId: "p-liu", due: "2026-10-09", evidence: ["seg-0012"], status: "done", feishuTaskId: "ft-51" }) },
  { meetingId: "m-1005-weekly", ...pushed({ id: "t-052", title: "对比 4 家 ASR 的中文转写准确率", ownerPersonId: "p-wang", due: "2026-10-11", evidence: ["seg-0027"], status: "done", feishuTaskId: "ft-52" }) },
  { meetingId: "m-1005-weekly", ...pushed({ id: "t-053", title: "整理自动化回归用例", ownerPersonId: "p-zhou", due: "2026-10-12", evidence: ["seg-0040"], status: "delayed", feishuTaskId: "ft-53" }) },
];
