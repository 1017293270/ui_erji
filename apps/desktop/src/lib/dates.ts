import { dateParts, dayLabel, daysBetween } from "@echomind/shared";
import { today } from "./store";

/** 今天, 明天, 逾期 2 天, 10-21 周三. */
export function dueLabel(due: string | null): { text: string; overdue: boolean; soon: boolean } {
  if (!due) return { text: "未定", overdue: false, soon: false };
  const n = daysBetween(today(), due);
  if (n < 0) return { text: `逾期 ${-n} 天`, overdue: true, soon: false };
  if (n === 0) return { text: "今天", overdue: false, soon: true };
  if (n === 1) return { text: "明天", overdue: false, soon: true };
  return { text: dayLabel(due), overdue: false, soon: false };
}

export function greeting(): string {
  const h = dateParts(today()).hour;
  if (h < 11) return "早上好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

/** Within the seven days ending today. */
export function thisWeek(iso: string): boolean {
  const n = daysBetween(iso, today());
  return n >= 0 && n < 7;
}
