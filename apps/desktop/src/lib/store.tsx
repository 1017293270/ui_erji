import { createContext, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { localDate, type Meeting, type MeetingSource, type Minutes, type Person, type Speaker, type Todo, type Transcript } from "@echomind/shared";
import { earlierTodos, meetings as sampleMeetings, people as samplePeople, SAMPLE_ME, SAMPLE_NOW } from "@echomind/shared/fixtures";
import {
  detectMeetings,
  feishuDirectory,
  feishuStatus,
  isTauri,
  meetingSave,
  meetingsList,
  onCaptureEvent,
  onVoiceprintsChanged,
  voiceprintAsk,
  voiceprintDelete,
  voiceprintRemember,
  voiceprintsList,
  type CaptureEvent,
  type DetectedMeeting,
  type FeishuStatus,
  type ModelsStatus,
  type PrivacySettings,
  type ServerVoiceprint,
  type UnsavedRecording,
} from "./native";
import { selfMention } from "@echomind/minutes-engine";
import { createProcessor, newMeetingTitle, type Job, type Processor } from "./process";
import { isMobile } from "./platform";

/**
 * App state. In the desktop app it is the real thing: meetings load from the
 * recordings folder and every change to one is written back, people come from
 * the 飞书 directory. In a plain browser (the design preview) it is the sample
 * meetings, in memory. Every change goes through `dispatch` either way.
 */
export const LIVE = isTauri;

/** "Now". The sample data is dated, so the demo reads its clock from it to keep relative dates meaningful. */
export function today(): string {
  return LIVE ? new Date().toISOString() : SAMPLE_NOW;
}

/** Who 「我」 is on this computer before signing in to 飞书. */
const LOCAL_ME = "me";
const ME_KEY = "echomind.me";

export type TodoItem = Todo & { meetingId: string };

/**
 * `enrolled`: a voiceprint is kept and meetings recognise them. `agreed`: they consented, no
 * sample yet. `pending`: a consent card is out. `declined`: they said no.
 */
export type VoiceprintStatus = "enrolled" | "agreed" | "pending" | "declined" | "none";
export type Voiceprint = { status: VoiceprintStatus; since?: string; samples?: number };

/** The server's voiceprints, keyed by person id (their open_id in the app). */
function fromServer(list: ServerVoiceprint[]): Record<string, Voiceprint> {
  const day = (iso: string | null) => (iso ? localDate(iso) : undefined);
  return Object.fromEntries(
    list.map((v): [string, Voiceprint] => {
      if (v.status === "asked") return [v.openId, { status: "pending", since: day(v.askedAt) }];
      if (v.status === "declined") return [v.openId, { status: "declined", since: day(v.answeredAt) }];
      return [v.openId, { status: v.enrolled ? "enrolled" : "agreed", since: day(v.answeredAt), samples: v.samples }];
    }),
  );
}

export type Recording = {
  startedAt: string;
  elapsed: number;
  paused: boolean;
  mic: number;
  system: number;
  marks: number[];
  micDevice?: string;
  source: MeetingSource;
  dir?: string;
};

/** `settings`: the toast offers to open that permission's settings page, and stays until closed. */
export type Toast = { id: number; text: string; tone: "default" | "success" | "error"; settings?: PrivacySettings };

export type Settings = {
  systemScope: "global" | "process";
  autoDetect: boolean;
  segmentSeconds: number;
  keepDays: number;
  digestTime: string;
  feishuConnected: boolean;
};

export type State = {
  meetings: Meeting[];
  todos: TodoItem[];
  people: Person[];
  /** The person id of whoever uses this computer: their 飞书 open_id once signed in. */
  me: string;
  /** Meetings and the directory have been read (always true in the demo). */
  loaded: boolean;
  /** Meetings being transcribed and summarized, by meeting id. */
  jobs: Record<string, Job>;
  /** The on-device speech models, and their download while it runs. */
  models: ModelsStatus | null;
  download: { received: number; total: number } | null;
  voiceprints: Record<string, Voiceprint>;
  recording: Recording | null;
  /** The first-run test recording: it is thrown away, not turned into a meeting. */
  testing: boolean;
  detected: DetectedMeeting | null;
  toasts: Toast[];
  settings: Settings;
  /** The real 飞书 account in the app; null in the browser preview (demo) until it loads. */
  feishu: FeishuStatus | null;
};

export type Action =
  | { type: "renameSpeaker"; meetingId: string; speakerId: string; personId: string | null; remember: boolean }
  | { type: "updateTodo"; id: string; patch: Partial<Todo> }
  | { type: "discardTodo"; id: string }
  | { type: "pushTodos"; meetingId: string; ids: string[]; taskIds?: Record<string, string> }
  | { type: "toggleDone"; id: string }
  | { type: "setVoiceprint"; personId: string; voiceprint: Voiceprint }
  | { type: "voiceprints"; voiceprints: Record<string, Voiceprint> }
  | { type: "capture"; event: CaptureEvent; keepMeeting: boolean }
  | { type: "recovered"; recordings: UnsavedRecording[] }
  | { type: "detected"; meeting: DetectedMeeting | null }
  | { type: "testing"; on: boolean }
  | { type: "settings"; patch: Partial<Settings> }
  | { type: "feishu"; status: FeishuStatus | null }
  | { type: "loaded"; meetings: Meeting[]; people: Person[] | null }
  | { type: "directory"; people: Person[] }
  | { type: "patchMeeting"; id: string; patch: Partial<Meeting> }
  | { type: "transcript"; meetingId: string; transcript: Transcript }
  | { type: "minutes"; meetingId: string; minutes: Minutes; todos: Todo[] }
  | { type: "job"; meetingId: string; job: Job | null }
  | { type: "models"; status: ModelsStatus | null }
  | { type: "download"; progress: { received: number; total: number } | null }
  | { type: "toast"; text: string; tone?: Toast["tone"] }
  | { type: "dismissToast"; id: number };

const settings: Settings = {
  systemScope: "global",
  autoDetect: true,
  segmentSeconds: 60,
  keepDays: 7,
  digestTime: "09:00",
  feishuConnected: !LIVE,
};

const common = { jobs: {}, models: null, download: null, recording: null, testing: false, detected: null, toasts: [], settings, feishu: null };

const demo: State = {
  ...common,
  meetings: sampleMeetings,
  todos: [...sampleMeetings.flatMap((m) => todosOf(m)), ...earlierTodos],
  people: samplePeople,
  me: SAMPLE_ME,
  loaded: true,
  voiceprints: {
    "p-chen": { status: "enrolled", since: "2026-09-21", samples: 18 },
    "p-wang": { status: "enrolled", since: "2026-09-28", samples: 9 },
    "p-li": { status: "enrolled", since: "2026-10-02", samples: 6 },
    "p-liu": { status: "pending", since: "2026-10-10" },
    "p-zhao": { status: "none" },
    "p-zhou": { status: "none" },
    "p-he": { status: "none" },
  },
};

function live(): State {
  const me = remembered() ?? LOCAL_ME;
  return { ...common, meetings: [], todos: [], people: withSelf([], me, null), me, loaded: false, voiceprints: {} };
}

function remembered(): string | null {
  try {
    return localStorage.getItem(ME_KEY);
  } catch {
    return null;
  }
}

function remember(me: string) {
  try {
    localStorage.setItem(ME_KEY, me);
  } catch {
    // Private storage off: the next start asks 飞书 again.
  }
}

function todosOf(meeting: Meeting): TodoItem[] {
  return (meeting.todos ?? []).map((t) => ({ ...t, meetingId: meeting.id }));
}

/** The meeting as it is written to disk: its todos come from the todo list, where they are edited. */
export function onDisk(meeting: Meeting, todos: TodoItem[]): Meeting {
  return { ...meeting, todos: todos.filter((t) => t.meetingId === meeting.id).map(({ meetingId: _, ...t }) => t) };
}

/** The directory, plus 「我」 when the directory does not have them (not signed in, or offline). */
function withSelf(people: Person[], me: string, feishu: FeishuStatus | null): Person[] {
  if (people.some((p) => p.id === me)) return people;
  const user = feishu?.user;
  const self: Person = { id: me, name: user?.name ?? "我", feishuOpenId: user?.openId, aliases: user?.enName ? [user.enName] : [], external: false };
  return [self, ...people.filter((p) => p.id !== LOCAL_ME)];
}

/** Meetings recorded before signing in belong to whoever signs in. */
function adopt(state: State, me: string): State {
  const was = state.me;
  const swap = (id: string | null) => (id === was ? me : id);
  const meetings = state.meetings.map((m): Meeting => ({
    ...m,
    recorderId: swap(m.recorderId) ?? me,
    participantIds: [...new Set(m.participantIds.map((id) => swap(id) ?? me))],
    transcript: m.transcript && { ...m.transcript, speakers: m.transcript.speakers.map((s) => ({ ...s, personId: swap(s.personId) })) },
  }));
  const todos = state.todos.map((t) => ({ ...t, ownerPersonId: swap(t.ownerPersonId) }));
  return { ...state, me, meetings, todos };
}

let toastId = 0;

const SOURCE_OF: Record<DetectedMeeting["app"], MeetingSource> = { tencent: "tencent", feishu: "feishu", lark: "feishu", zoom: "zoom" };

/** The recording folder's name, which is the meeting's id. */
function folderName(dir: string | undefined): string | null {
  const name = dir?.split(/[\\/]/).filter(Boolean).pop();
  return name && /^[A-Za-z0-9._-]{1,80}$/.test(name) ? name : null;
}

function onCapture(state: State, event: CaptureEvent, keepMeeting: boolean): State {
  const rec = state.recording;
  switch (event.type) {
    case "started":
      return {
        ...state,
        recording: {
          startedAt: event.startedAt,
          elapsed: 0,
          paused: false,
          mic: -90,
          system: -90,
          marks: [],
          micDevice: event.mic?.device ?? undefined,
          // A phone records the room it is in.
          source: isMobile ? "offline" : state.detected ? SOURCE_OF[state.detected.app] : "other",
          dir: event.out,
        },
      };
    case "level": {
      // A window opened mid-recording (the floating recorder) missed "started"; pick it up from here.
      const base: Recording = rec ?? {
        startedAt: new Date(Date.now() - event.t).toISOString(),
        elapsed: 0,
        paused: false,
        mic: -90,
        system: -90,
        marks: [],
        source: state.detected ? SOURCE_OF[state.detected.app] : "other",
      };
      return { ...state, recording: { ...base, elapsed: event.t, mic: event.mic ?? -90, system: event.system ?? -90 } };
    }
    case "mark":
      return rec ? { ...state, recording: { ...rec, marks: [...rec.marks, event.atMs] } } : state;
    case "paused":
    case "resumed":
      return rec ? { ...state, recording: { ...rec, paused: event.type === "paused" } } : state;
    case "device-changed":
      return rec && event.track === "mic" ? { ...state, recording: { ...rec, micDevice: event.device } } : state;
    case "error":
      return withToast(state, event.message, "error", event.settings ?? undefined);
    case "stopped": {
      if (!rec) return state;
      const stopped = { ...state, recording: null, testing: false };
      if (!keepMeeting || state.testing) return stopped;
      const id = folderName(rec.dir) ?? `m-${Date.parse(rec.startedAt)}`;
      const meeting = recorded(state, { id, startedAt: rec.startedAt, durationMs: event.durationMs, marks: rec.marks }, rec.source);
      const text = LIVE ? "录音已保存，正在本机转写。" : "录音已保存。转写服务接入后会自动生成纪要。";
      return withToast({ ...stopped, meetings: [meeting, ...state.meetings.filter((m) => m.id !== meeting.id)] }, text, "success");
    }
    default:
      return state;
  }
}

/** A meeting for a recording made on this device; it is processed from "transcribing" on. */
function recorded(state: State, r: UnsavedRecording, source: Meeting["source"]): Meeting {
  return {
    id: r.id,
    title: newMeetingTitle(r.startedAt),
    source,
    status: "transcribing",
    startedAt: r.startedAt,
    durationMs: r.durationMs,
    recorderId: state.me,
    participantIds: [state.me],
    marks: r.marks,
  };
}

function withToast(state: State, text: string, tone: Toast["tone"] = "default", settings?: PrivacySettings): State {
  return { ...state, toasts: [...state.toasts, { id: ++toastId, text, tone, settings }] };
}

function patchMeeting(state: State, id: string, patch: (m: Meeting) => Meeting): State {
  return { ...state, meetings: state.meetings.map((m) => (m.id === id ? patch(m) : m)) };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "renameSpeaker": {
      const next = patchMeeting(state, action.meetingId, (m) => {
        if (!m.transcript) return m;
        const speakers = m.transcript.speakers.map(
          (s): Speaker => (s.id === action.speakerId ? { ...s, personId: action.personId, source: action.personId ? "manual" : "unknown", confidence: undefined } : s),
        );
        return { ...m, transcript: { ...m.transcript, speakers } };
      });
      const person = state.people.find((p) => p.id === action.personId);
      // Todos this speaker claimed (「我来」) follow the name, unless someone already picked an owner by hand.
      let claimed = 0;
      const todos = next.todos.map((t): TodoItem => {
        const claim = selfMention(t.ownerMention);
        if (t.meetingId !== action.meetingId || t.ownerSpeakerId !== action.speakerId || t.status !== "draft" || !claim) return t;
        if (t.ownerBasis !== "unresolved" && t.ownerBasis !== "self-claimed") return t;
        claimed += 1;
        return person
          ? { ...t, ownerPersonId: person.id, ownerBasis: "self-claimed", ownerConfidence: claim === "team" ? 0.6 : 0.9, external: person.external }
          : { ...t, ownerPersonId: null, ownerBasis: "unresolved", ownerConfidence: 0.5, external: false };
      });
      const renamed = { ...next, todos };
      // Voiceprints (and the consent card that comes first) are only in the demo so far.
      if (!LIVE && action.remember && person && !person.external && state.voiceprints[person.id]?.status !== "enrolled") {
        const enrolled = { ...renamed, voiceprints: { ...renamed.voiceprints, [person.id]: { status: "pending" as const, since: localDate(today()) } } };
        return withToast(enrolled, `已命名为 ${person.name}。同意卡片已发给 ${person.name}，本人同意后才会保存声纹。`, "success");
      }
      if (!person) return renamed;
      return withToast(renamed, `已命名为 ${person.name}${claimed ? `，会上认领的 ${claimed} 项待办已改由 ${person.name} 负责` : ""}`, claimed ? "success" : "default");
    }
    case "updateTodo":
      return { ...state, todos: state.todos.map((t) => (t.id === action.id ? { ...t, ...action.patch } : t)) };
    case "discardTodo":
      return { ...state, todos: state.todos.filter((t) => t.id !== action.id) };
    case "pushTodos": {
      const ids = new Set(action.ids);
      const taskId = (t: TodoItem) => (action.taskIds ? action.taskIds[t.id] : t.external ? undefined : `ft-${t.id}`);
      const todos = state.todos.map((t): TodoItem => (ids.has(t.id) ? { ...t, status: "pushed", feishuTaskId: taskId(t) } : t));
      // A push that stopped halfway leaves the meeting waiting for the rest.
      const done = !todos.some((t) => t.meetingId === action.meetingId && t.status === "draft");
      return { ...patchMeeting(state, action.meetingId, (m) => (done ? { ...m, status: "pushed" } : m)), todos };
    }
    case "toggleDone":
      return {
        ...state,
        todos: state.todos.map((t) => (t.id === action.id ? { ...t, status: t.status === "done" ? "pushed" : "done" } : t)),
      };
    case "setVoiceprint":
      return { ...state, voiceprints: { ...state.voiceprints, [action.personId]: action.voiceprint } };
    case "voiceprints":
      return { ...state, voiceprints: action.voiceprints };
    case "capture":
      return onCapture(state, action.event, action.keepMeeting);
    case "detected":
      return { ...state, detected: action.meeting };
    case "testing":
      return { ...state, testing: action.on };
    case "settings":
      return { ...state, settings: { ...state.settings, ...action.patch } };
    case "feishu": {
      const user = action.status?.user;
      // Signing out keeps 「我」: the meetings on this computer are still theirs.
      const next = LIVE && user && user.openId !== state.me ? adopt(state, user.openId) : state;
      if (next !== state) remember(next.me);
      const feishuConnected = LIVE ? !!user : state.settings.feishuConnected;
      return {
        ...next,
        feishu: action.status,
        people: LIVE ? withSelf(next.people, next.me, action.status) : next.people,
        settings: { ...next.settings, feishuConnected },
      };
    }
    case "loaded": {
      // Anything made while loading (a meeting stopped in the first second) stays.
      const ids = new Set(action.meetings.map((m) => m.id));
      const meetings = [...state.meetings.filter((m) => !ids.has(m.id)), ...action.meetings];
      const todos = [...state.todos.filter((t) => !ids.has(t.meetingId)), ...action.meetings.flatMap(todosOf)];
      const people = withSelf(action.people ?? state.people, state.me, state.feishu);
      return { ...state, meetings, todos, people, loaded: true };
    }
    case "recovered": {
      // Only meetings recorded on the phone come back this way, so they were in the room.
      const found = action.recordings.filter((r) => !state.meetings.some((m) => m.id === r.id));
      if (!found.length) return state;
      const meetings = [...found.map((r) => recorded(state, r, "offline")), ...state.meetings];
      return withToast({ ...state, meetings }, `找回了 ${found.length} 场上次没来得及保存的录音，正在转写。`, "success");
    }
    case "directory":
      return { ...state, people: withSelf(action.people, state.me, state.feishu) };
    case "patchMeeting":
      return patchMeeting(state, action.id, (m) => ({ ...m, ...action.patch }));
    case "transcript":
      return patchMeeting(state, action.meetingId, (m) => ({ ...m, transcript: action.transcript }));
    case "minutes": {
      // New drafts replace the old ones; todos already confirmed or pushed stay.
      const next = patchMeeting(state, action.meetingId, (m) => ({ ...m, minutes: action.minutes, status: "review" }));
      const todos = action.todos.map((t) => ({ ...t, meetingId: action.meetingId }));
      return { ...next, todos: [...next.todos.filter((t) => t.meetingId !== action.meetingId || t.status !== "draft"), ...todos] };
    }
    case "job": {
      const jobs = { ...state.jobs };
      if (action.job) jobs[action.meetingId] = action.job;
      else delete jobs[action.meetingId];
      return { ...state, jobs };
    }
    case "models":
      return { ...state, models: action.status };
    case "download":
      return { ...state, download: action.progress };
    case "toast":
      return withToast(state, action.text, action.tone);
    case "dismissToast":
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
  }
}

type Store = State & {
  dispatch: (action: Action) => void;
  toast: (text: string, tone?: Toast["tone"]) => void;
  person: (id: string | null | undefined) => Person | undefined;
  /** Transcribes and summarizes a meeting again (after an error, or to regenerate). */
  process: Processor["retry"];
  rediarize: Processor["rediarize"];
  downloadModels: Processor["download"];
  /** Reads the company's voiceprints from the server again (the app only). */
  refreshVoiceprints: () => Promise<void>;
  /** After naming a speaker with 「记住声音」 ticked: keep the voice, or ask the person first. */
  rememberVoice: (meetingId: string, speakerId: string, personId: string) => Promise<void>;
  askVoiceprint: (personId: string) => Promise<void>;
  deleteVoiceprint: (personId: string) => Promise<void>;
};

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ children, recorderWindow = false }: { children: ReactNode; recorderWindow?: boolean }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => (LIVE ? live() : demo));
  const main = LIVE && !recorderWindow;

  const latest = useRef(state);
  latest.current = state;
  const processor = useMemo(() => createProcessor({ get: () => latest.current, dispatch }), []);
  /** What each meeting's meeting.json holds now, so only real changes are written. */
  const saved = useRef(new Map<string, string>());

  useEffect(() => onCaptureEvent((event) => dispatch({ type: "capture", event, keepMeeting: !recorderWindow })), [recorderWindow]);

  useEffect(() => {
    if (recorderWindow) return;
    void feishuStatus()
      .then((status) => {
        dispatch({ type: "feishu", status });
        if (status?.user && status.missingScopes?.length) {
          dispatch({ type: "toast", text: "飞书登录需要更新一次：到「设置 → 飞书」重新登录，授予读取日历和创建任务的权限。" });
        }
      })
      .catch(() => {});
  }, [recorderWindow]);

  // Meetings from the recordings folder and the 飞书 directory, before anything is processed.
  useEffect(() => {
    if (!main) return;
    let alive = true;
    void (async () => {
      const [meetings, people] = await Promise.allSettled([meetingsList(), feishuDirectory()]);
      if (!alive) return;
      if (meetings.status === "rejected") dispatch({ type: "toast", text: `读取会议记录失败：${String(meetings.reason)}`, tone: "error" });
      const loaded = meetings.status === "fulfilled" ? meetings.value : [];
      for (const m of loaded) saved.current.set(m.id, JSON.stringify(onDisk(m, todosOf(m))));
      dispatch({ type: "loaded", meetings: loaded, people: people.status === "fulfilled" ? people.value : null });
    })();
    void processor.refreshModels();
    return () => {
      alive = false;
    };
  }, [main, processor]);

  const voiceprintActions = useMemo(() => voiceprintsFor({ get: () => latest.current, dispatch }), []);

  // Signing in (or switching accounts) brings that company's directory.
  const openId = state.feishu?.user?.openId;
  useEffect(() => {
    if (!main || !openId || !latest.current.loaded) return;
    void feishuDirectory()
      .then((people) => dispatch({ type: "directory", people }))
      .catch(() => {});
  }, [main, openId]);

  // And its voiceprints; samples waiting for someone's consent go out on the way, and later
  // in the background.
  useEffect(() => {
    if (main && openId) void voiceprintActions.refreshVoiceprints();
  }, [main, openId, voiceprintActions]);
  useEffect(() => (main ? onVoiceprintsChanged(() => void voiceprintActions.refreshVoiceprints()) : undefined), [main, voiceprintActions]);

  // Write each meeting that changed, a moment after the last change.
  const { meetings, todos, loaded } = state;
  useEffect(() => {
    if (!main || !loaded) return;
    const timer = setTimeout(() => {
      for (const meeting of meetings) {
        const json = JSON.stringify(onDisk(meeting, todos));
        if (saved.current.get(meeting.id) === json) continue;
        saved.current.set(meeting.id, json);
        meetingSave(JSON.parse(json) as Meeting).catch((e) => {
          saved.current.delete(meeting.id);
          dispatch({ type: "toast", text: `保存「${meeting.title}」失败：${String(e)}`, tone: "error" });
        });
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [main, loaded, meetings, todos]);

  // A meeting that just stopped, or was still being processed when the app quit, gets processed.
  useEffect(() => {
    if (!main || !loaded) return;
    for (const m of meetings) if (m.status === "transcribing") processor.start(m.id);
  }, [main, loaded, meetings, processor]);

  // Watch for Tencent Meeting / Feishu calls so we can offer to record them.
  const autoDetect = state.settings.autoDetect;
  useEffect(() => {
    if (!isTauri || !autoDetect || recorderWindow || isMobile) return;
    let alive = true;
    const poll = async () => {
      try {
        const found = await detectMeetings();
        if (alive) dispatch({ type: "detected", meeting: found.find((m) => m.usingMic) ?? null });
      } catch {
        // The sidecar is missing in some dev builds; detection just stays off.
      }
    };
    void poll();
    const timer = setInterval(poll, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [autoDetect, recorderWindow]);

  const store = useMemo<Store>(
    () => ({
      ...state,
      dispatch,
      toast: (text, tone = "default") => dispatch({ type: "toast", text, tone }),
      person: (id) => (id ? state.people.find((p) => p.id === id) : undefined),
      process: processor.retry,
      rediarize: processor.rediarize,
      downloadModels: processor.download,
      ...voiceprintActions,
    }),
    [state, processor, voiceprintActions],
  );

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

/** Voiceprints through the server (docs/voiceprints.md). Outcomes are told in toasts. */
function voiceprintsFor({ get, dispatch }: { get: () => State; dispatch: (action: Action) => void }) {
  const toast = (text: string, tone: Toast["tone"] = "default") => dispatch({ type: "toast", text, tone });
  const nameOf = (personId: string) => get().people.find((p) => p.id === personId)?.name ?? "对方";
  const message = (e: unknown) => String(e).replace(/。$/, "");

  const refreshVoiceprints = async () => {
    if (!LIVE) return;
    try {
      dispatch({ type: "voiceprints", voiceprints: fromServer(await voiceprintsList()) });
    } catch (e) {
      console.warn("voiceprints not loaded:", e);
    }
  };

  const rememberVoice = async (meetingId: string, speakerId: string, personId: string) => {
    const name = nameOf(personId);
    const title = get().meetings.find((m) => m.id === meetingId)?.title;
    try {
      const outcome = await voiceprintRemember(meetingId, speakerId, personId, title);
      const self = personId === get().me;
      switch (outcome.status) {
        case "saved":
          toast(self ? "已记住你的声音，以后开会会自动认出你。" : `已把这段声音加进${name}的声纹。`, "success");
          break;
        case "asked":
          toast(`已给${name}发了飞书卡片，${name}点同意后，这段声音会自动存进声纹。`, "success");
          break;
        case "waiting":
          toast(`之前已经给${name}发过同意卡片，${name}点同意后，这段声音会自动存进声纹。`);
          break;
        case "declined":
          toast(`${name}没有同意保存声纹，这段声音没有保存。`);
          break;
      }
    } catch (e) {
      toast(`没能记住${name}的声音：${message(e)}。`, "error");
    }
    await refreshVoiceprints();
  };

  const askVoiceprint = async (personId: string) => {
    const name = nameOf(personId);
    try {
      await voiceprintAsk(personId);
      toast(`已给${name}发了飞书卡片，${name}点同意后，下次给${name}命名时就会记住声音。`, "success");
    } catch (e) {
      toast(`没能发出卡片：${message(e)}。`, "error");
    }
    await refreshVoiceprints();
  };

  const deleteVoiceprint = async (personId: string) => {
    const name = nameOf(personId);
    try {
      await voiceprintDelete(personId);
      toast(personId === get().me ? "已删除你的声纹。" : `已删除${name}的声纹，以后的会议里需要重新命名。`);
    } catch (e) {
      toast(`没能删除声纹：${message(e)}。`, "error");
    }
    await refreshVoiceprints();
  };

  return { refreshVoiceprints, rememberVoice, askVoiceprint, deleteVoiceprint };
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore outside StoreProvider");
  return store;
}

/** What the transcript calls a speaker: their name once known, otherwise 说话人 N. */
export function speakerName(store: Pick<Store, "person">, speaker: Speaker | undefined): string {
  if (!speaker) return "未知";
  return store.person(speaker.personId)?.name ?? speaker.label;
}

/** Index of a speaker's color (1–6), stable within a meeting. */
export function speakerTone(speakerId: string): number {
  const n = Number(speakerId.replace(/\D/g, "")) || 1;
  return ((n - 1) % 6) + 1;
}

/**
 * What to call someone in a greeting. Chinese names drop the family name once
 * they have three characters or more (陈晓雯 → 晓雯); two-character names and
 * names in Latin letters stay whole (王磊, Alex).
 */
export function callName(name: string): string {
  const trimmed = name.trim();
  if (!/^[一-鿿]+$/.test(trimmed)) return trimmed.split(/\s+/)[0] ?? trimmed;
  return trimmed.length >= 3 ? trimmed.slice(1) : trimmed;
}
