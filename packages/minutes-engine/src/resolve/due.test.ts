import { describe, expect, it } from "vitest";
import { reviewMeeting } from "@echomind/shared/fixtures";
import { parseCnNumber, resolveDue, shanghaiDay } from "./due";

// The fixture meeting: Monday 2026-10-12, 10:00 Beijing time.
const MEETING = reviewMeeting.startedAt;

describe("resolveDue", () => {
  it("uses the fixture's Monday", () => {
    expect(MEETING).toBe("2026-10-12T10:00:00+08:00");
    expect(shanghaiDay(MEETING)).toBe("2026-10-12");
  });

  it.each([
    // the cases the gold todos use
    ["下周三", "2026-10-21"],
    ["下周三之前", "2026-10-21"],
    ["周五前", "2026-10-16"],
    ["下周一前", "2026-10-19"],
    ["这周内", "2026-10-16"],
    ["月底前", "2026-10-31"],
    // relative days
    ["今天", "2026-10-12"],
    ["今天下班前", "2026-10-12"],
    ["明天", "2026-10-13"],
    ["后天", "2026-10-14"],
    ["大后天", "2026-10-15"],
    // weekdays: 周 / 星期 / 礼拜, this week unless passed
    ["周一", "2026-10-12"],
    ["周三", "2026-10-14"],
    ["星期五", "2026-10-16"],
    ["礼拜五之前", "2026-10-16"],
    ["星期天", "2026-10-18"],
    ["周日", "2026-10-18"],
    ["本周四", "2026-10-15"],
    ["这周五", "2026-10-16"],
    ["这个星期五", "2026-10-16"],
    ["下周五", "2026-10-23"],
    ["下个星期三", "2026-10-21"],
    ["下礼拜二", "2026-10-20"],
    ["下下周一", "2026-10-26"],
    // whole weeks
    ["本周内", "2026-10-16"],
    ["这周之内", "2026-10-16"],
    ["这周", "2026-10-16"],
    ["下周内", "2026-10-23"],
    ["下周", "2026-10-23"],
    ["下周之前", "2026-10-16"],
    ["这周末", "2026-10-18"],
    ["一周内", "2026-10-19"],
    ["两周内", "2026-10-26"],
    ["三天内", "2026-10-15"],
    // months
    ["月底", "2026-10-31"],
    ["这个月底", "2026-10-31"],
    ["本月底前", "2026-10-31"],
    ["下个月底", "2026-11-30"],
    ["十一月底", "2026-11-30"],
    ["11月底之前", "2026-11-30"],
    ["月中", "2026-10-15"],
    ["年底", "2026-12-31"],
    // dates
    ["10月20号", "2026-10-20"],
    ["十月二十日", "2026-10-20"],
    ["10月20日前", "2026-10-20"],
    ["１０月２０号", "2026-10-20"], // full-width digits
    ["11月3号", "2026-11-03"],
    ["9月30号", "2027-09-30"], // already past this year
    ["2026年11月5日", "2026-11-05"],
    ["20号", "2026-10-20"],
    ["二十号之前", "2026-10-20"],
    ["5号", "2026-11-05"], // the 5th has passed this month
    ["下个月5号", "2026-11-05"],
    ["10/28", "2026-10-28"],
  ])("%s → %s", (text, expected) => {
    expect(resolveDue(text, MEETING)).toBe(expected);
  });

  it.each([null, undefined, "", "尽快", "之后再说", "这两天", "回头"])("%s → null", (text) => {
    expect(resolveDue(text, MEETING)).toBeNull();
  });

  it("goes by the day in Shanghai, not UTC", () => {
    // 00:30 in Beijing is still the previous day in UTC.
    expect(resolveDue("明天", "2026-10-12T00:30:00+08:00")).toBe("2026-10-13");
    expect(resolveDue("明天", "2026-10-11T16:30:00Z")).toBe("2026-10-13");
    expect(resolveDue("今天", "2026-10-12T23:59:00+08:00")).toBe("2026-10-12");
  });

  it("said on a Saturday: 这周内 is Sunday, 周一 is next week", () => {
    const saturday = "2026-10-17T10:00:00+08:00";
    expect(resolveDue("这周内", saturday)).toBe("2026-10-18");
    expect(resolveDue("周一", saturday)).toBe("2026-10-19");
    expect(resolveDue("周六", saturday)).toBe("2026-10-17");
  });

  it("rolls over month and year ends", () => {
    expect(resolveDue("下周三", "2026-12-28T10:00:00+08:00")).toBe("2027-01-06");
    expect(resolveDue("下个月底", "2026-12-10T10:00:00+08:00")).toBe("2027-01-31");
    expect(resolveDue("月底", "2028-02-03T10:00:00+08:00")).toBe("2028-02-29");
  });

  it("accepts a plain date as the meeting day", () => {
    expect(resolveDue("周五前", "2026-10-12")).toBe("2026-10-16");
  });
});

describe("parseCnNumber", () => {
  it.each([
    ["3", 3],
    ["十", 10],
    ["十一", 11],
    ["二十", 20],
    ["二十一", 21],
    ["三十一", 31],
    ["两", 2],
    ["廿五", 25],
  ])("%s → %s", (s, n) => {
    expect(parseCnNumber(s)).toBe(n);
  });

  it("rejects what is not a number", () => {
    expect(parseCnNumber("周")).toBeNull();
    expect(parseCnNumber("一二三")).toBeNull();
  });
});
