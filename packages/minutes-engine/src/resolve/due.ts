/**
 * Turns a due date as said in a meeting (下周三之前, 周五前, 月底前) into
 * YYYY-MM-DD, relative to the meeting day in Asia/Shanghai. Deterministic code,
 * not the model: the model only copies the words. Unknown phrasing → null.
 *
 * Weeks run Monday to Sunday. A bare 周X means this week's X, or next week's
 * if it has already passed. 这周内 / 本周内 means Friday, the end of the
 * working week.
 */

interface Day {
  y: number;
  m: number; // 1–12
  d: number;
}

const SHANGHAI_OFFSET_MS = 8 * 3600_000;

/** The calendar day of an ISO date-time in Asia/Shanghai (China has no DST). */
export function shanghaiDay(iso: string): string {
  return format(dayOf(iso));
}

function dayOf(iso: string): Day {
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (plain) return { y: Number(plain[1]), m: Number(plain[2]), d: Number(plain[3]) };
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`无法识别的会议时间：${iso}`);
  const local = new Date(t + SHANGHAI_OFFSET_MS);
  return { y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate() };
}

const toUtc = (day: Day) => Date.UTC(day.y, day.m - 1, day.d);
const fromUtc = (ms: number): Day => {
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
};
const addDays = (day: Day, n: number): Day => fromUtc(toUtc(day) + n * 86400_000);
const lastDay = (y: number, m: number): Day => fromUtc(Date.UTC(y, m, 0));
/** Monday = 1 … Sunday = 7. */
const weekday = (day: Day) => ((new Date(toUtc(day)).getUTCDay() + 6) % 7) + 1;
const compare = (a: Day, b: Day) => toUtc(a) - toUtc(b);
const format = (day: Day) =>
  `${String(day.y).padStart(4, "0")}-${String(day.m).padStart(2, "0")}-${String(day.d).padStart(2, "0")}`;

function addMonths(day: Day, n: number): Day {
  const index = day.y * 12 + (day.m - 1) + n;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return { y, m, d: Math.min(day.d, lastDay(y, m).d) };
}

function validDay(y: number, m: number, d: number): Day | null {
  if (m < 1 || m > 12 || d < 1 || d > lastDay(y, m).d) return null;
  return { y, m, d };
}

const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 3, 十一, 二十一, 三十, 廿五 → number. */
export function parseCnNumber(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === "半") return 0.5;
  const text = s.replace(/^廿/, "二十").replace(/^卅/, "三十");
  if (!/^[零〇一二两三四五六七八九十]+$/.test(text)) return null;
  if (!text.includes("十")) {
    return text.length === 1 ? (CN_DIGITS[text] ?? null) : null;
  }
  const [tens, ones] = text.split("十") as [string, string];
  const t = tens === "" ? 1 : CN_DIGITS[tens];
  const o = ones === "" ? 0 : CN_DIGITS[ones];
  if (t === undefined || o === undefined || tens.length > 1 || ones.length > 1) return null;
  return t * 10 + o;
}

const NUM = "[0-9零〇一二两三四五六七八九十廿卅]+";
const WEEK = "(?:周|星期|礼拜)";
const WEEKDAY: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7 };
const WD = "([一二三四五六日天1-7])";

function normalize(text: string): string {
  return text
    .normalize("NFKC") // full-width digits → ASCII
    .replace(/\s+/g, "")
    .replace(/个(?=(?:周|星期|礼拜|月))/g, "") // 下个星期三 → 下星期三, 下个月底 → 下月底
    .replace(/这(?=(?:周|星期|礼拜|月))/g, "本");
}

type Rule = [RegExp, (m: RegExpExecArray, today: Day) => Day | null];

const RULES: Rule[] = [
  // 2026年10月20日
  [new RegExp(`(\\d{4})年(${NUM})月(${NUM})[日号]`), (m) => cnDate(Number(m[1]), m[2]!, m[3]!)],
  // 下月5号
  [new RegExp(`下月(${NUM})[日号]`), (m, today) => {
    const next = addMonths({ ...today, d: 1 }, 1);
    const d = parseCnNumber(m[1]!);
    return d === null ? null : validDay(next.y, next.m, d);
  }],
  // 10月20号, 十月二十日, 10月20
  [new RegExp(`(${NUM})月(${NUM})(?:[日号]|$|前|之前|以前)`), (m, today) => upcoming(today, m[1]!, m[2]!)],
  // 10/20, 10.20
  [/(?:^|[^\d.])(\d{1,2})[/.](\d{1,2})(?![\d.])/, (m, today) => upcoming(today, m[1]!, m[2]!)],
  // 下月底, 11月底, 本月底, 月底
  [/下月[底末]/, (_, today) => {
    const next = addMonths({ ...today, d: 1 }, 1);
    return lastDay(next.y, next.m);
  }],
  [new RegExp(`(${NUM})月[底末]`), (m, today) => {
    const month = parseCnNumber(m[1]!);
    if (month === null || month < 1 || month > 12) return null;
    const end = lastDay(today.y, month);
    return compare(end, today) < 0 ? lastDay(today.y + 1, month) : end;
  }],
  [/月[底末]/, (_, today) => lastDay(today.y, today.m)],
  [/下月中/, (_, today) => addMonths({ ...today, d: 15 }, 1)],
  [/月中/, (_, today) => {
    const mid = { ...today, d: 15 };
    return compare(mid, today) < 0 ? addMonths(mid, 1) : mid;
  }],
  [/年[底末]/, (_, today) => ({ y: today.y, m: 12, d: 31 })],
  // 三天内, 两周内, 一个月内, 半个月内
  [new RegExp(`(${NUM}|半)(?:天|日)(?:内|之内|以内|后|之后|以后)`), (m, today) => {
    const n = parseCnNumber(m[1]!);
    return n === null || n < 1 ? null : addDays(today, Math.round(n));
  }],
  [new RegExp(`(${NUM})${WEEK}(?:内|之内|以内|后|之后|以后)`), (m, today) => {
    const n = parseCnNumber(m[1]!);
    return n === null || n < 1 ? null : addDays(today, n * 7);
  }],
  [new RegExp(`半月(?:内|之内|以内|后)`), (_, today) => addDays(today, 15)],
  [new RegExp(`(${NUM})月(?:内|之内|以内|后|之后|以后)`), (m, today) => {
    const n = parseCnNumber(m[1]!);
    return n === null || n < 1 || !Number.isInteger(n) ? null : addMonths(today, n);
  }],
  [/大后天/, (_, today) => addDays(today, 3)],
  [/后天/, (_, today) => addDays(today, 2)],
  [/明天|明日|明早|明晚/, (_, today) => addDays(today, 1)],
  [/今天|今日|今晚|今早|当天|今儿|下班前/, (_, today) => today],
  [new RegExp(`下下${WEEK}${WD}`), (m, today) => weekDay(today, 2, m[1]!)],
  [new RegExp(`下${WEEK}${WD}`), (m, today) => weekDay(today, 1, m[1]!)],
  [new RegExp(`本${WEEK}${WD}`), (m, today) => weekDay(today, 0, m[1]!)],
  [new RegExp(`${WEEK}${WD}`), (m, today) => {
    const day = weekDay(today, 0, m[1]!);
    return day && compare(day, today) < 0 ? addDays(day, 7) : day;
  }],
  // 下周之前: before next week starts, so the end of this working week.
  [new RegExp(`下${WEEK}(?:之前|以前|前)`), (_, today) => endOfWorkWeek(today, 0)],
  [new RegExp(`下下${WEEK}`), (_, today) => endOfWorkWeek(today, 2)],
  [new RegExp(`下${WEEK}`), (_, today) => endOfWorkWeek(today, 1)],
  [new RegExp(`${WEEK}末`), (_, today) => weekDay(today, 0, "日")],
  [new RegExp(`本${WEEK}|^${WEEK}内`), (_, today) => endOfWorkWeek(today, 0)],
  // 20号前: this month, or next month if the day has passed
  [new RegExp(`(${NUM})[日号]`), (m, today) => {
    const d = parseCnNumber(m[1]!);
    if (d === null || d < 1 || d > 31) return null;
    const thisMonth = validDay(today.y, today.m, d);
    if (thisMonth && compare(thisMonth, today) >= 0) return thisMonth;
    const next = addMonths({ ...today, d: 1 }, 1);
    return validDay(next.y, next.m, d);
  }],
];

function weekDay(today: Day, weeksAhead: number, wd: string): Day | null {
  const target = WEEKDAY[wd];
  if (!target) return null;
  const monday = addDays(today, 1 - weekday(today));
  return addDays(monday, weeksAhead * 7 + target - 1);
}

function endOfWorkWeek(today: Day, weeksAhead: number): Day {
  const friday = weekDay(today, weeksAhead, "五")!;
  // Said on a weekend about this week: Friday has gone, so Sunday.
  return compare(friday, today) < 0 ? weekDay(today, weeksAhead, "日")! : friday;
}

function cnDate(y: number, month: string, day: string): Day | null {
  const m = parseCnNumber(month);
  const d = parseCnNumber(day);
  return m === null || d === null ? null : validDay(y, m, d);
}

/** A month and day without a year: the next time it comes round. */
function upcoming(today: Day, month: string, day: string): Day | null {
  const thisYear = cnDate(today.y, month, day);
  if (!thisYear) return null;
  return compare(thisYear, today) < 0 ? cnDate(today.y + 1, month, day) : thisYear;
}

export function resolveDue(dueText: string | null | undefined, meetingDate: string): string | null {
  if (!dueText) return null;
  const text = normalize(dueText);
  if (!text) return null;
  const today = dayOf(meetingDate);
  for (const [pattern, resolve] of RULES) {
    const match = pattern.exec(text);
    if (!match) continue;
    const day = resolve(match, today);
    if (day) return format(day);
  }
  return null;
}
