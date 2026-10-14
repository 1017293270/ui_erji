import { parseIsoSecs } from "../dates";
import { type Feishu, FeishuError, MalformedError, type Reply, text } from "./client";

/** Who was invited to the calendar event a recording happened in. */
export type Attendees = { eventTitle: string; attendeeIds: string[] };

type Picked = { eventId: string; title: string; organizer: string | null };

const secs = (value: unknown): number | null => (typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null);

/**
 * The event instance overlapping `[start, end)` the most. All-day events (no timestamp) are
 * not meetings; on a tie the shorter, more specific event wins.
 */
export function pickEvent(items: Reply[], [start, end]: [number, number]): Picked | null {
  let best: { overlap: number; length: number; event: Reply } | null = null;
  for (const event of items) {
    if (event.status === "cancelled") continue;
    const from = secs(event.start_time?.timestamp);
    const to = secs(event.end_time?.timestamp);
    if (from === null || to === null) continue;
    const overlap = Math.min(to, end) - Math.max(from, start);
    if (overlap <= 0) continue;
    const length = to - from;
    if (!best || overlap > best.overlap || (overlap === best.overlap && length < best.length)) best = { overlap, length, event };
  }
  const eventId = best && text(best.event.event_id);
  if (!best || !eventId) return null;
  const organizer = text(best.event.event_organizer?.user_id);
  return { eventId, title: text(best.event.summary) ?? "", organizer: organizer?.startsWith("ou_") ? organizer : null };
}

/** Declined and removed people did not come; the organizer counts either way. */
const attending = (a: Reply) => a.is_external !== true && (a.is_organizer === true || !["decline", "removed"].includes(a.rsvp_status));

const BY_OPEN_ID = { user_id_type: "open_id", page_size: "100" };

async function eventAttendees(feishu: Feishu, token: string, calendar: string, event: string): Promise<string[]> {
  const path = ["calendar", "v4", "calendars", calendar, "events", event, "attendees"];
  const ids: string[] = [];
  for (const attendee of (await feishu.getAll(token, path, BY_OPEN_ID)).filter(attending)) {
    if (attendee.type === "user") {
      const id = text(attendee.user_id);
      if (id) ids.push(id);
    } else if (attendee.type === "chat" && text(attendee.attendee_id)) {
      // A group invited as a whole: its members.
      const members = await feishu.getAll(token, [...path, attendee.attendee_id, "chat_members"], BY_OPEN_ID);
      for (const m of members.filter(attending)) {
        const id = text(m.open_id);
        if (id) ids.push(id);
      }
    }
  }
  return ids;
}

export async function meetingAttendees(feishu: Feishu, token: { accessToken: string; openId: string }, window: [number, number]): Promise<Attendees | null> {
  const access = token.accessToken;
  const primary = await feishu.send(feishu.url(["calendar", "v4", "calendars", "primary"], { user_id_type: "open_id" }), {
    method: "POST",
    token: access,
    json: {},
  });
  const calendar = text(primary.data?.calendars?.[0]?.calendar?.calendar_id);
  if (!calendar) throw new MalformedError("主日历");

  // instance_view expands recurring events into their instances in the window.
  const data = await feishu.get(access, ["calendar", "v4", "calendars", calendar, "events", "instance_view"], {
    start_time: String(window[0]),
    end_time: String(window[1]),
    user_id_type: "open_id",
  });
  const event = pickEvent(Array.isArray(data.items) ? data.items : [], window);
  if (!event) return null;

  let ids: string[];
  try {
    try {
      ids = await eventAttendees(feishu, access, calendar, event.eventId);
    } catch (e) {
      // An unmodified instance of a recurring event has an id like `<event>_<start>`; if Feishu
      // does not know that id, the series has the same attendees.
      if (!(e instanceof FeishuError && (e.code === 193000 || e.code === 193001) && event.eventId.includes("_"))) throw e;
      ids = await eventAttendees(feishu, access, calendar, event.eventId.slice(0, event.eventId.lastIndexOf("_")));
    }
  } catch (e) {
    // The organizer hid the guest list: the organizer and the person recording still count.
    if (!(e instanceof FeishuError && e.code === 194001)) throw e;
    ids = [];
  }
  if (event.organizer) ids.push(event.organizer);
  ids.push(token.openId);
  return { eventTitle: event.title, attendeeIds: [...new Set(ids)] };
}

export function meetingWindow(start: string, end: string): [number, number] {
  const parse = (s: string) => {
    const secs = parseIsoSecs(s);
    if (secs === null) throw new RangeError(`会议时间「${s}」不是 ISO 8601 格式。`);
    return secs;
  };
  const [from, to] = [parse(start), parse(end)];
  if (to < from) throw new RangeError("会议的结束时间早于开始时间。");
  // Feishu caps the window at 40 days; no meeting comes close.
  if (to - from > 7 * 86_400) throw new RangeError("会议时间跨度超过 7 天，找不到对应的日程。");
  // A zero-length window overlaps nothing.
  return [from, Math.max(to, from + 60)];
}
