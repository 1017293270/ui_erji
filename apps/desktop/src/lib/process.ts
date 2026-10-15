import { DeepSeekProvider, runPipeline, type PipelineStep } from "@echomind/minutes-engine";
import { dateParts, type Meeting, type Person, type Scene, type Transcript } from "@echomind/shared";
import {
  feishuMeetingAttendees,
  llmFetch,
  llmStatus,
  onModelDownload,
  onTranscribe,
  transcribeDownload,
  transcribeModels,
  transcribeStart,
  voicesMatch,
  type ModelsStatus,
  type TranscribeHints,
  type TranscribeStage,
} from "./native";
import type { Action, State } from "./store";

/**
 * After a meeting: transcribe it on this computer, find who was there from the
 * 飞书 calendar, then have DeepSeek write the minutes and draft the todos. The
 * audio never leaves the computer; only the transcript goes to DeepSeek.
 */

export type JobStep = "models" | "transcribe" | "minutes";

export type Job = {
  /** "models": waiting for the speech models to be downloaded. */
  step: JobStep;
  /** The transcriber's pass, or the minutes engine's call. */
  stage?: TranscribeStage | PipelineStep | "voices" | "attendees";
  /** 0–1 within the stage. */
  progress: number;
  error?: string;
};

export const STAGE_LABEL: Record<NonNullable<Job["stage"]>, string> = {
  prepare: "正在读取录音",
  speech: "正在找出说话的片段",
  speakers: "正在区分说话人",
  text: "正在把语音转成文字",
  voices: "正在用声纹认出说话人",
  attendees: "正在从飞书日历找参会人",
  chapters: "DeepSeek 正在划分议题",
  minutes: "DeepSeek 正在写纪要",
  todos: "DeepSeek 正在找待办",
};

export const SCENE_NAME: Record<Scene, string> = { "in-person": "面对面", online: "线上" };

export type Processor = {
  /** Processes a meeting once per run of the app: a new one, or one interrupted by quitting. */
  start: (meetingId: string) => void;
  /** Runs again after an error, or regenerates the minutes from the transcript. */
  retry: (meetingId: string) => void;
  /** Transcribes again as an in-person or online meeting (with this many people, if given), then writes the minutes again. */
  rediarize: (meetingId: string, hints: TranscribeHints) => void;
  download: () => Promise<void>;
  refreshModels: () => Promise<ModelsStatus | null>;
};

export function newMeetingTitle(startedAt: string) {
  const d = dateParts(startedAt);
  return `新会议 ${d.month}月${d.day}日 ${String(d.hour).padStart(2, "0")}:${String(d.minute).padStart(2, "0")}`;
}

/** 230 MB, 1.2 GB. */
export function formatBytes(bytes: number) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The transcriber found the speech models missing or damaged: they need downloading (again). */
class ModelsMissing extends Error {}

/** At most one update per interval: progress events come by the hundred. */
function throttle<T extends unknown[]>(fn: (...args: T) => void, ms = 150) {
  let last = 0;
  return (...args: T) => {
    const now = Date.now();
    if (now - last < ms) return;
    last = now;
    fn(...args);
  };
}

export function createProcessor({ get, dispatch }: { get: () => State; dispatch: (action: Action) => void }): Processor {
  const started = new Set<string>();
  const running = new Set<string>();
  const find = (id: string) => get().meetings.find((m) => m.id === id);
  const setJob = (meetingId: string, job: Job | null) => dispatch({ type: "job", meetingId, job });
  const toast = (text: string, tone: "default" | "success" | "error" = "default") => dispatch({ type: "toast", text, tone });

  async function refreshModels() {
    const status = await transcribeModels().catch(() => null);
    dispatch({ type: "models", status });
    return status;
  }

  async function run(id: string, hints?: TranscribeHints) {
    if (running.has(id)) return;
    const before = find(id);
    if (!before) return;
    running.add(id);
    let step: JobStep = "transcribe";
    let transcribed = false;
    try {
      dispatch({ type: "patchMeeting", id, patch: { status: "transcribing" } });

      // State read through get() lags a dispatch until React renders, so the meeting travels along here.
      let meeting = before;
      if (!meeting.transcript || hints) {
        const models = await transcribeModels();
        dispatch({ type: "models", status: models });
        if (!models?.ready) {
          setJob(id, { step: "models", progress: 0 });
          return;
        }
        setJob(id, { step, stage: "prepare", progress: 0 });
        const progress = throttle((stage: TranscribeStage, p: number) => setJob(id, { step: "transcribe", stage, progress: p }));
        let transcript = claimMic(await transcribe(id, progress, hints), get().me);
        if (get().feishu?.user) {
          setJob(id, { step, stage: "voices", progress: 0 });
          transcript = await recognise(id, transcript, get().people);
        }
        dispatch({ type: "transcript", meetingId: id, transcript });
        meeting = { ...meeting, transcript };
        transcribed = true;
      }

      if (!meeting.transcript?.segments.length) {
        throw new Error("录音里没有识别到说话声。确认麦克风和系统录音权限都打开了，再录一次。");
      }

      step = "minutes";
      setJob(id, { step, stage: "attendees", progress: 0 });
      const calendar = await attendees(meeting);
      const titled = !isDefaultTitle(meeting) ? meeting.title : calendar?.eventTitle;
      if (calendar) {
        const patch = { participantIds: calendar.participantIds, ...(titled ? { title: titled } : {}) };
        dispatch({ type: "patchMeeting", id, patch });
        meeting = { ...meeting, ...patch };
      }

      const result = await summarize(meeting, get().people, (stage, p) => setJob(id, { step: "minutes", stage, progress: p }));
      // The engine numbers todos t-1, t-2… per run; ids must be unique across meetings and regenerations.
      const batch = Date.now().toString(36);
      const todos = result.todos.map((t) => ({ ...t, id: `${id}.${batch}.${t.id}` }));
      dispatch({ type: "minutes", meetingId: id, minutes: result.minutes, todos });
      if (!titled) dispatch({ type: "patchMeeting", id, patch: { title: result.minutes.title } });
      setJob(id, null);
      const drafts = result.todos.length;
      if (hints) toast(`已按${SCENE_NAME[hints.scene]}会议${hints.speakers ? `、${hints.speakers} 人` : ""}重新区分说话人，纪要和待办草稿也已更新。`, "success");
      else toast(`「${titled ?? result.minutes.title}」的纪要已生成${drafts ? `，有 ${drafts} 项待办等你确认` : ""}。`, "success");
    } catch (e) {
      if (e instanceof ModelsMissing) {
        void refreshModels();
        setJob(id, { step: "models", progress: 0 });
        return;
      }
      // Regenerating minutes that already exist: keep them and say why it did not work.
      if (before.minutes) {
        dispatch({ type: "patchMeeting", id, patch: { status: before.status } });
        setJob(id, null);
        if (!hints) toast(`重新生成失败：${message(e)}`, "error");
        else if (!transcribed) toast(`重新区分说话人失败：${message(e)}`, "error");
        else toast(`说话人已重新区分，但纪要没能更新：${message(e).replace(/。$/, "")}。可以在「纪要」里点「重新生成」再试。`, "error");
      } else {
        dispatch({ type: "patchMeeting", id, patch: { status: "failed" } });
        setJob(id, { step, progress: 0, error: message(e) });
      }
    } finally {
      running.delete(id);
    }
  }

  async function download() {
    if (get().download) return;
    dispatch({ type: "download", progress: { received: 0, total: get().models?.downloadBytes ?? 0 } });
    const stop = await onModelDownload(throttle((progress) => dispatch({ type: "download", progress })));
    try {
      await transcribeDownload();
      const models = await refreshModels();
      if (!models?.ready) throw new Error("下载完成了，但模型文件校验没有通过。请再试一次。");
      toast("语音模型已就绪，开始转写。", "success");
      for (const [id, job] of Object.entries(get().jobs)) if (job.step === "models") void run(id);
    } catch (e) {
      toast(`模型下载失败：${message(e)}`, "error");
    } finally {
      stop();
      dispatch({ type: "download", progress: null });
    }
  }

  return {
    start: (id) => {
      if (started.has(id)) return;
      started.add(id);
      void run(id);
    },
    retry: (id) => {
      started.add(id);
      setJob(id, null);
      void run(id);
    },
    rediarize: (id, hints) => {
      started.add(id);
      setJob(id, null);
      void run(id, hints);
    },
    download,
    refreshModels,
  };
}

async function transcribe(id: string, progress: (stage: TranscribeStage, p: number) => void, hints?: TranscribeHints): Promise<Transcript> {
  let settle!: { resolve: (t: Transcript) => void; reject: (e: Error) => void };
  const done = new Promise<Transcript>((resolve, reject) => (settle = { resolve, reject }));
  const stop = await onTranscribe((event) => {
    if (event.meetingId !== id) return;
    if (event.stage === "done") settle.resolve(event.transcript);
    else if (event.stage === "error") settle.reject(event.kind === "models_missing" ? new ModelsMissing(event.message) : new Error(event.message));
    else progress(event.stage, event.progress);
  });
  try {
    await transcribeStart(id, hints);
    return await done;
  } finally {
    stop();
  }
}

/**
 * Speakers the company's voiceprints recognise get their names. Best effort: no voiceprints,
 * no server, no problem. Names already given (「我」 on the mic) stay, and nobody gets two voices.
 */
async function recognise(meetingId: string, transcript: Transcript, people: Person[]): Promise<Transcript> {
  let matches;
  try {
    matches = await voicesMatch(meetingId);
  } catch (e) {
    console.warn("voiceprint matching skipped:", message(e));
    return transcript;
  }
  const taken = new Set(transcript.speakers.map((s) => s.personId).filter(Boolean));
  const speakers = transcript.speakers.map((s) => {
    const match = matches.find((m) => m.speakerId === s.id);
    if (s.personId || !match || taken.has(match.openId) || !people.some((p) => p.id === match.openId)) return s;
    taken.add(match.openId);
    return { ...s, personId: match.openId, source: "voiceprint" as const, confidence: match.score };
  });
  return { ...transcript, speakers };
}

/** The voice the transcriber took for the person recording (S1 「我」) is linked to them. */
function claimMic(transcript: Transcript, me: string): Transcript {
  return {
    ...transcript,
    speakers: transcript.speakers.map((s) => (s.track === "mic" && s.source === "self" && !s.personId ? { ...s, personId: me } : s)),
  };
}

function isDefaultTitle(meeting: Meeting) {
  return meeting.title === newMeetingTitle(meeting.startedAt);
}

/** Who was invited, from the 飞书 calendar event at that time. Best effort: no event, no sign-in, no problem. */
async function attendees(meeting: Meeting): Promise<{ eventTitle: string; participantIds: string[] } | null> {
  const end = new Date(Date.parse(meeting.startedAt) + meeting.durationMs).toISOString();
  try {
    const found = await feishuMeetingAttendees(meeting.startedAt, end);
    if (!found) return null;
    return { eventTitle: found.eventTitle, participantIds: [...new Set([meeting.recorderId, ...meeting.participantIds, ...found.attendeeIds])] };
  } catch (e) {
    console.warn("calendar lookup skipped:", message(e));
    return null;
  }
}

async function summarize(meeting: Meeting, directory: Person[], progress: (stage: PipelineStep, p: number) => void) {
  const llm = await llmStatus();
  if (!llm?.configured) throw new Error("还没有配置 DeepSeek：在 apps/desktop/.env.local 写上 DEEPSEEK_API_KEY，重启应用后点「重试」。");
  // The key is added by the app's Rust side; this page never sees it.
  const provider = new DeepSeekProvider({ apiKey: "added-by-the-app", model: llm.model, fetch: llmFetch });
  let done = 0;
  return runPipeline(meeting, {
    provider,
    directory,
    onProgress: (step, state) => {
      if (state === "done") done += 1;
      progress(step, done / 3);
    },
  });
}
