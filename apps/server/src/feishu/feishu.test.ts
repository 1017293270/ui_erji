import { describe, expect, it } from "vitest";
import { allDayTimestamp, parseIsoSecs } from "../dates";
import { fakeFeishu, ok } from "../testing/feishu";
import { meetingAttendees, meetingWindow, pickEvent } from "./calendar";
import { explain, FeishuError, HttpError, MalformedError, NetworkError, violatedScopes } from "./client";
import { buildDirectory, fetchDirectory } from "./directory";
import { missingScopes } from "./oauth";
import { createTask, taskBody } from "./tasks";

describe("errors", () => {
  it("say what to fix", () => {
    const reply = {
      code: 99991672,
      msg: "Access denied. One of the following scopes is required: [contact:contact.base:readonly, contact:contact:readonly_as_app].",
      error: { permission_violations: [{ type: "action_scope_required", subject: "task:task:write" }, { subject: "task:task:writeonly" }] },
    };
    const scopes = violatedScopes(reply);
    expect(scopes).toEqual(["task:task:write", "task:task:writeonly"]);
    const message = explain(new FeishuError(99991672, "", scopes), "user");
    expect(message).toContain("「task:task:write」「task:task:writeonly」中任意一项");
    expect(message).toContain("发布新版本");

    // Older replies only list the scopes in the message.
    const older = violatedScopes({ msg: "Unauthorized. required one of these privileges under the user identity: [calendar:calendar:read, calendar:calendar:readonly]" });
    expect(older).toEqual(["calendar:calendar:read", "calendar:calendar:readonly"]);
    expect(explain(new FeishuError(99991679, "", older), "user")).toContain("重新用飞书登录");

    expect(explain(new FeishuError(99991677, "token expire"), "user")).toContain("重新用飞书登录");
    expect(explain(new FeishuError(99991663, ""), "user")).toContain("登录已经过期");
    expect(explain(new FeishuError(99991663, ""), "app")).toContain("访问凭证无效");
    expect(explain(new FeishuError(41050, "no user authority"), "app")).toContain("通讯录权限范围");
    expect(explain(new FeishuError(20010, ""), "user")).toContain("可用范围");
    expect(explain(new FeishuError(1470400, "Invalid Param 'summary'"), "user")).toMatch(/Invalid Param 'summary'$/);
    expect(explain(new FeishuError(12345, "boom"), "app")).toBe("飞书接口出错（12345）：boom");
    expect(explain(new NetworkError("timed out"), "app")).toMatch(/^连不上飞书/);
    expect(explain(new HttpError(502), "app")).toContain("502");
    expect(explain(new MalformedError("任务 ID"), "app")).toContain("任务 ID");
  });

  it("knows which sign-in scopes are missing", () => {
    expect(missingScopes("auth:user.id:read offline_access")).toEqual(["task:task:write", "calendar:calendar:read", "calendar:calendar.event:read"]);
    expect(missingScopes("calendar:calendar.event:read task:task:write offline_access calendar:calendar:read")).toEqual([]);
    expect(missingScopes(null)).toHaveLength(4);
    // A prefix of a scope is not the scope.
    expect(missingScopes("offline_access task:task:write calendar:calendar calendar:calendar.event:read")).toContain("calendar:calendar:read");
  });
});

describe("client", () => {
  it("caches the tenant token, asks once for concurrent callers, and replaces a rejected one", async () => {
    let issued = 0;
    let rejectNext = false;
    const { feishu, requests } = fakeFeishu((req) => {
      if (req.path.endsWith("/tenant_access_token/internal")) return [200, { code: 0, tenant_access_token: `t-${++issued}`, expire: 7200 }];
      if (rejectNext) {
        rejectNext = false;
        return [400, { code: 99991663, msg: "invalid token" }];
      }
      return ok({ who: req.authorization });
    });
    const [a, b] = await Promise.all([feishu.tenantToken(), feishu.tenantToken()]);
    expect([a, b]).toEqual(["t-1", "t-1"]);
    expect(requests[0]!.body).toEqual({ app_id: "cli_test", app_secret: "secret" });
    rejectNext = true;
    const data = await feishu.asApp((token) => feishu.get(token, ["x"]));
    expect(data).toEqual({ who: "Bearer t-2" });
    expect(requests.filter((r) => r.path.endsWith("/internal"))).toHaveLength(2);
  });

  it("pages through lists and tells network, HTTP and Feishu failures apart", async () => {
    const { feishu } = fakeFeishu((req) => {
      if (req.path.endsWith("/list")) {
        return req.query.get("page_token") ? ok({ has_more: false, items: [2] }) : ok({ has_more: true, page_token: "p2", items: [1] });
      }
      if (req.path.endsWith("/html")) return [502, "<html>bad gateway</html>"];
      if (req.path.endsWith("/down")) throw new TypeError("fetch failed");
      return [400, { code: 40004, msg: "no dept authority error" }];
    });
    expect(await feishu.getAll("t", ["list"])).toEqual([1, 2]);
    await expect(feishu.get("t", ["html"])).rejects.toBeInstanceOf(HttpError);
    await expect(feishu.get("t", ["down"])).rejects.toBeInstanceOf(NetworkError);
    await expect(feishu.get("t", ["other"])).rejects.toMatchObject({ code: 40004 });
  });
});

describe("directory", () => {
  it("builds people from sample replies", () => {
    const departments = [
      { open_department_id: "od-sales", name: "销售部", parent_department_id: "0" },
      { open_department_id: "od-rd", name: "研发部" },
    ];
    const members: [string, Record<string, unknown>][] = [
      ["0", { open_id: "ou_boss", name: "王总", en_name: "David", nickname: "David", job_title: "CEO", status: { is_activated: true } }],
      ["od-sales", { open_id: "ou_wang", name: "王小明", nickname: "小王", en_name: " ", department_ids: ["od-sales", "od-rd"], status: {} }],
      // Listed again under a second department: one person.
      ["od-rd", { open_id: "ou_wang", name: "王小明", department_ids: ["od-sales", "od-rd"] }],
      ["od-rd", { open_id: "ou_left", name: "已离职", status: { is_resigned: true } }],
      ["od-rd", { open_id: "ou_frozen", name: "暂停", status: { is_frozen: true } }],
      ["od-rd", { open_id: "ou_li", name: "李雷", en_name: "Li Lei" }],
      ["od-rd", { name: "没有 open_id" }],
    ];
    const { people, hints } = buildDirectory(departments, members);
    expect(hints).toEqual([]);
    expect(people).toEqual([
      { id: "ou_boss", name: "王总", feishuOpenId: "ou_boss", title: "CEO", aliases: ["David"], external: false },
      { id: "ou_wang", name: "王小明", feishuOpenId: "ou_wang", department: "销售部", aliases: ["小王"], external: false },
      { id: "ou_li", name: "李雷", feishuOpenId: "ou_li", department: "研发部", aliases: ["Li Lei"], external: false },
    ]);
  });

  it("degrades without optional scopes", () => {
    const { people, hints } = buildDirectory([{ open_department_id: "od-1" }], [["od-1", { open_id: "ou_1", name: "张三" }], ["0", { open_id: "ou_2" }]]);
    expect(people).toEqual([{ id: "ou_1", name: "张三", feishuOpenId: "ou_1", aliases: [], external: false }]);
    expect(hints.map((h) => h.scope)).toEqual(["contact:department.base:readonly", "contact:user.employee:readonly", "contact:user.base:readonly"]);
  });

  it("walks departments page by page, level by level when the tenant is too big", async () => {
    let tooBig = false;
    const { feishu, requests } = fakeFeishu((req) => {
      if (req.path === "/open-apis/contact/v3/departments/0/children") {
        if (tooBig && req.query.get("fetch_child") === "true") return [400, { code: 43010, msg: "too many" }];
        if (tooBig) return ok({ items: [{ open_department_id: "od-a", name: "A 部" }] });
        return req.query.get("page_token")
          ? ok({ has_more: false, items: [{ open_department_id: "od-b", name: "B 部" }] })
          : ok({ has_more: true, page_token: "p2", items: [{ open_department_id: "od-a", name: "A 部" }] });
      }
      if (req.path === "/open-apis/contact/v3/departments/od-a/children") return ok({ items: [{ open_department_id: "od-b", name: "B 部" }] });
      if (req.path === "/open-apis/contact/v3/departments/od-b/children") return ok({ items: [] });
      if (req.path === "/open-apis/contact/v3/users/find_by_department") {
        const items = { "0": [{ open_id: "ou_root", name: "根" }], "od-a": [{ open_id: "ou_a", name: "甲", status: {} }], "od-b": [{ open_id: "ou_a", name: "甲" }, { open_id: "ou_b", name: "乙" }] };
        return ok({ items: items[req.query.get("department_id") as keyof typeof items] });
      }
      return [404, "not found"];
    });
    const { people } = await fetchDirectory(feishu, "t-test");
    expect(people.map((p) => [p.id, p.department ?? null])).toEqual([["ou_root", null], ["ou_a", "A 部"], ["ou_b", "B 部"]]);
    expect(requests).toHaveLength(5);
    expect(requests.every((r) => r.authorization === "Bearer t-test" && r.query.get("page_size") === "50")).toBe(true);
    expect(requests[2]!.query.get("user_id_type")).toBe("open_id");

    tooBig = true;
    expect((await fetchDirectory(feishu, "t")).people).toHaveLength(3);
  });
});

const event = (id: string, start: number, end: number) => ({
  event_id: id,
  summary: id,
  status: "confirmed",
  start_time: { timestamp: String(start) },
  end_time: { timestamp: String(end) },
  event_organizer: { user_id: "ou_org", display_name: "组织者" },
});

describe("calendar", () => {
  it("picks the event overlapping most", () => {
    const items = [
      event("before", 0, 1500),
      event("main", 900, 4500),
      { event_id: "all-day", status: "confirmed", start_time: { date: "2026-10-13" }, end_time: { date: "2026-10-14" } },
      { ...event("cancelled", 1000, 4600), status: "cancelled" },
      event("after", 4600, 9000),
    ];
    expect(pickEvent(items, [1000, 4600])).toEqual({ eventId: "main", title: "main", organizer: "ou_org" });
    // Same overlap: the shorter event is the more specific one.
    expect(pickEvent([event("all-afternoon", 0, 20_000), event("standup", 1000, 4600)], [1000, 4600])?.eventId).toBe("standup");
    expect(pickEvent([event("after", 4600, 9000)], [1000, 4600])).toBeNull();
  });

  it("reads meeting windows, Beijing time when no offset is given", () => {
    expect(meetingWindow("2026-10-13T01:00:00Z", "2026-10-13T02:00:00Z")).toEqual([1_791_853_200, 1_791_856_800]);
    expect(meetingWindow("2026-10-13T09:00:00+08:00", "2026-10-13T09:00:00+08:00")).toEqual([1_791_853_200, 1_791_853_260]);
    expect(meetingWindow("2026-10-13 09:00", "2026-10-13T10:00:00.000+0800")).toEqual([1_791_853_200, 1_791_856_800]);
    expect(() => meetingWindow("2026-10-13T02:00:00Z", "2026-10-13T01:00:00Z")).toThrow("早于");
    expect(() => meetingWindow("today", "2026-10-13T01:00:00Z")).toThrow("today");
    expect(parseIsoSecs("2026-02-30T00:00:00Z")).toBeNull();
  });

  it("finds the attendees of a recurring instance through its series", async () => {
    const cal = "feishu.cn_abc@group.calendar.feishu.cn";
    const base = `/open-apis/calendar/v4/calendars/${encodeURIComponent(cal)}/events`;
    const { feishu, requests } = fakeFeishu((req) => {
      switch (req.path) {
        case "/open-apis/calendar/v4/calendars/primary":
          return ok({ calendars: [{ calendar: { calendar_id: cal }, user_id: "u1" }] });
        case `${base}/instance_view`:
          return ok({ items: [event("series-1_1791853200", 1_791_853_200, 1_791_856_800)] });
        // Feishu does not know the instance id; the series does.
        case `${base}/series-1_1791853200/attendees`:
          return [404, { code: 193001, msg: "event not found" }];
        case `${base}/series-1/attendees`:
          return ok({
            has_more: false,
            items: [
              { type: "user", user_id: "ou_a", rsvp_status: "accept" },
              { type: "user", user_id: "ou_declined", rsvp_status: "decline" },
              { type: "user", user_id: "ou_org", rsvp_status: "decline", is_organizer: true },
              { type: "user", user_id: "ou_guest", is_external: true },
              { type: "resource", room_id: "omm_room" },
              { type: "chat", attendee_id: "chat_1", chat_id: "oc_1", rsvp_status: "needs_action" },
            ],
          });
        case `${base}/series-1/attendees/chat_1/chat_members`:
          return ok({
            has_more: false,
            items: [
              { open_id: "ou_b", rsvp_status: "needs_action" },
              { open_id: "ou_a", rsvp_status: "accept" },
              { open_id: "ou_c", rsvp_status: "removed" },
            ],
          });
      }
      return [404, { code: 404, msg: req.path }];
    });
    const found = await meetingAttendees(feishu, { accessToken: "u-test", openId: "ou_me" }, [1_791_853_300, 1_791_856_000]);
    expect(found).toEqual({ eventTitle: "series-1_1791853200", attendeeIds: ["ou_a", "ou_org", "ou_b", "ou_me"] });
    expect(requests.every((r) => r.authorization === "Bearer u-test")).toBe(true);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[1]!.query.get("start_time")).toBe("1791853300");
    expect(requests.slice(2).every((r) => r.query.get("user_id_type") === "open_id")).toBe(true);
  });

  it("falls back to the organizer when the guest list is hidden", async () => {
    const { feishu } = fakeFeishu((req) => {
      if (req.path.endsWith("/primary")) return ok({ calendars: [{ calendar: { calendar_id: "cal" } }] });
      if (req.path.endsWith("/instance_view")) return ok({ items: [event("e1", 0, 100)] });
      return [403, { code: 194001, msg: "no permission to list event attendees" }];
    });
    const token = { accessToken: "u", openId: "ou_me" };
    expect((await meetingAttendees(feishu, token, [10, 90]))?.attendeeIds).toEqual(["ou_org", "ou_me"]);
    expect(await meetingAttendees(feishu, token, [200, 300])).toBeNull();
  });
});

describe("tasks", () => {
  it("sends all-day due dates as the UTC day", () => {
    // The example in Feishu's task docs: 1682899200000 shows as 2023-05-01 everywhere.
    expect(allDayTimestamp("2023-05-01")).toBe("1682899200000");
    expect(allDayTimestamp("2026-10-20")).toBe("1792454400000");
    expect(allDayTimestamp("2026-10-32")).toBeNull();
    expect(allDayTimestamp("2026/10/20")).toBeNull();
  });

  it("builds task bodies and says what is wrong", () => {
    expect(taskBody({ title: " 整理报价单 ", description: "  ", due: "2026-10-20", assigneeId: "ou_wang" })).toEqual({
      summary: "整理报价单",
      members: [{ id: "ou_wang", type: "user", role: "assignee" }],
      origin: { platform_i18n_name: { zh_cn: "EchoMind 会议纪要", en_us: "EchoMind" } },
      due: { timestamp: "1792454400000", is_all_day: true },
    });
    expect(taskBody({ title: "t", description: "见会议第 3 段", assigneeId: "ou_wang" }).description).toBe("见会议第 3 段");
    expect([...(taskBody({ title: "长".repeat(3100), assigneeId: "ou_x" }).summary as string)]).toHaveLength(3000);
    expect(() => taskBody({ title: "  ", assigneeId: "ou_wang" })).toThrow("标题");
    expect(() => taskBody({ title: "t", assigneeId: "person-12" })).toThrow("通讯录");
    expect(() => taskBody({ title: "t", due: "下周三", assigneeId: "ou_wang" })).toThrow("下周三");
  });

  it("creates the task as the given user", async () => {
    const { feishu, requests } = fakeFeishu(() =>
      ok({ task: { guid: "83912691-2e43-47fc-94a4-d512e03984fa", url: "https://applink.feishu.cn/client/todo/detail?guid=83912691" } }),
    );
    const body = taskBody({ title: "整理报价单", due: "2026-10-20", assigneeId: "ou_wang" });
    expect(await createTask(feishu, "u-token", body)).toEqual({
      guid: "83912691-2e43-47fc-94a4-d512e03984fa",
      url: "https://applink.feishu.cn/client/todo/detail?guid=83912691",
    });
    expect(requests[0]).toMatchObject({ method: "POST", path: "/open-apis/task/v2/tasks", authorization: "Bearer u-token", body });
    expect(requests[0]!.query.get("user_id_type")).toBe("open_id");
  });
});
