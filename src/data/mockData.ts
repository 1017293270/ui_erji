import type { LucideIcon } from "lucide-react";
import { AudioWaveform, CalendarDays, ListChecks } from "lucide-react";

export type MeetingStatus = "已生成" | "生成中" | "待处理";

export interface Meeting {
  id: number;
  title: string;
  attendees: number;
  time: string;
  duration: string;
  status: MeetingStatus;
}

export interface Stat {
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
  positive?: boolean;
}

export const stats: Stat[] = [
  { label: "本月会议", value: "48 场", detail: "+12%", icon: CalendarDays, positive: true },
  { label: "转写时长", value: "32.6 h", detail: "+8%", icon: AudioWaveform, positive: true },
  { label: "AI 待办", value: "126 项", detail: "已完成 84", icon: ListChecks },
];

export const meetings: Meeting[] = [
  { id: 1, title: "产品 Q3 路线图评审", attendees: 4, time: "今天 09:30", duration: "48:26", status: "已生成" },
  { id: 2, title: "大客户交付周会", attendees: 4, time: "昨天 16:00", duration: "36:14", status: "已生成" },
  { id: 3, title: "Echo Buds 固件复盘", attendees: 4, time: "8月1日 14:20", duration: "52:08", status: "生成中" },
  { id: 4, title: "市场创意碰撞会", attendees: 4, time: "7月31日 10:00", duration: "41:35", status: "已生成" },
  { id: 5, title: "用户研究访谈 #12", attendees: 4, time: "7月30日 15:30", duration: "28:19", status: "待处理" },
];

export const insightTasks = [
  { id: 1, title: "完善企业词库导入方案", meta: "周屿 · 明天" },
  { id: 2, title: "确认离线模型包体积", meta: "陈禾 · 周三" },
  { id: 3, title: "整理首批灰度客户名单", meta: "林墨 · 周五" },
];
