/** The little calendar arithmetic the server needs. People using EchoMind are in mainland China. */

const BEIJING_OFFSET = "+08:00";

/** `YYYY-MM-DD`, checked: 2026-02-30 is not a date. */
export function parseDate(s: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? { year, month, day } : null;
}

/**
 * Seconds since the epoch for an ISO 8601 date-time such as `2026-10-13T01:30:00.000Z`,
 * `2026-10-13T09:30:00+08:00` or `2026-10-13 09:30`. No offset means Beijing time.
 */
export function parseIsoSecs(s: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2}))?(?:[.,]\d+)?)?\s*(Z|z|[+-]\d{2}:?\d{2})?$/.exec(s.trim());
  if (!m || !parseDate(m[1]!)) return null;
  const [hour, minute, second] = [Number(m[2] ?? 0), Number(m[3] ?? 0), Number(m[4] ?? 0)];
  if (hour > 23 || minute > 59 || second > 60) return null;
  let zone = m[5] ?? BEIJING_OFFSET;
  if (/^[+-]\d{4}$/.test(zone)) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const pad = (n: number) => String(n).padStart(2, "0");
  const ms = Date.parse(`${m[1]}T${pad(hour)}:${pad(minute)}:${pad(Math.min(second, 59))}${zone.toUpperCase()}`);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000) + (second === 60 ? 1 : 0);
}

/**
 * Feishu keeps only the UTC day of an all-day timestamp and shows that day in every time zone.
 * So 2026-10-20 is sent as 2026-10-20T00:00Z: Beijing midnight (16:00 UTC the day before)
 * would show up as the 19th.
 */
export function allDayTimestamp(date: string): string | null {
  const d = parseDate(date);
  return d ? String(Date.UTC(d.year, d.month - 1, d.day)) : null;
}
