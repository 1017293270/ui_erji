/**
 * Meetings are shown in Beijing time: the customers are mainland companies,
 * and a meeting recorded at 10:00 in Shanghai should read 10:00 wherever the
 * app is opened.
 */
export const DISPLAY_TIME_ZONE = "Asia/Shanghai";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  weekday: "short",
  hourCycle: "h23",
});

export type DateParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

/** The calendar parts of an ISO date (YYYY-MM-DD, taken as is) or date-time (in Beijing time). */
export function dateParts(iso: string): DateParts {
  if (iso.length === 10) {
    const d = new Date(`${iso}T00:00:00Z`);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: 0, minute: 0, weekday: d.getUTCDay() };
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAY_INDEX[parts.weekday ?? "Sun"] ?? 0,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** YYYY-MM-DD of an ISO date or date-time, in Beijing time. */
export function localDate(iso: string): string {
  const p = dateParts(iso);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** 1:02:03 or 12:34, from milliseconds into the meeting. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  return h > 0 ? `${h}:${mm}:${pad(s)}` : `${mm}:${pad(s)}`;
}

/** 1 小时 12 分, 35 分钟, 40 秒. */
export function duration(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

/** 10-12 周一. */
export function dayLabel(iso: string): string {
  const p = dateParts(iso);
  return `${pad(p.month)}-${pad(p.day)} ${WEEKDAYS[p.weekday]}`;
}

/** 10:00. */
export function timeOfDay(iso: string): string {
  const p = dateParts(iso);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** Whole calendar days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${localDate(from)}T00:00:00Z`);
  const b = Date.parse(`${localDate(to)}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}
