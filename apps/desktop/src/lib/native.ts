import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Meeting, Person, Scene, Transcript } from "@echomind/shared";

/**
 * The bridge to the native side. Inside the Tauri app, recording runs in the
 * `echomind-capture` sidecar and its JSON events arrive as `capture://event`.
 * In a plain browser (the design preview) a simulator plays the same events,
 * shared across tabs, so every screen can be shown without a microphone.
 */

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export type CaptureEvent =
  | {
      type: "started";
      startedAt: string;
      sampleRate?: number;
      /** The folder the WAV segments and manifest.json are written to. */
      out?: string;
      /** null when the track is off. */
      mic?: { device: string | null } | null;
      system?: { scope: string; device?: string | null } | null;
    }
  /** dBFS per track every 100 ms; null for a track that is off. */
  | { type: "level"; t: number; mic: number | null; system: number | null }
  | { type: "segment"; index: number; startMs: number; endMs: number; mic?: string | null; system?: string | null }
  | { type: "mark"; atMs: number }
  | { type: "paused"; atMs: number }
  | { type: "resumed"; atMs: number }
  | { type: "device-changed"; track: "mic" | "system"; device: string }
  | { type: "error"; code: string; message: string; settings?: PrivacySettings | null }
  | { type: "stopped"; durationMs: number; segments: number };

export type CaptureCommand = "pause" | "resume" | "mark" | "stop";

export type DetectedMeeting = {
  app: "tencent" | "feishu" | "lark" | "zoom";
  name: string;
  pid: number;
  usingMic: boolean;
  playingAudio: boolean;
};

export type PermissionState = "granted" | "denied" | "undetermined" | "restricted" | "unknown";

/** A permission whose system settings page the app can open. */
export type PrivacySettings = "microphone" | "systemAudio";

export async function startCapture(): Promise<void> {
  if (isTauri) {
    await invoke("capture_start");
    return;
  }
  simulator.start();
}

export async function sendCapture(command: CaptureCommand): Promise<void> {
  if (isTauri) {
    await invoke("capture_command", { command });
    return;
  }
  simulator.command(command);
}

/** A Tauri event listener with a synchronous unsubscribe, for use in effects. */
function subscribe<T>(event: string, handler: (payload: T) => void): () => void {
  let stop: (() => void) | undefined;
  let cancelled = false;
  void listen<T>(event, (e) => handler(e.payload)).then((unlisten) => {
    if (cancelled) unlisten();
    else stop = unlisten;
  });
  return () => {
    cancelled = true;
    stop?.();
  };
}

export function onCaptureEvent(handler: (event: CaptureEvent) => void): () => void {
  if (isTauri) return subscribe("capture://event", handler);
  return simulator.subscribe(handler);
}

/** Meeting apps that are running right now, and whether they are in a call. */
export async function detectMeetings(): Promise<DetectedMeeting[]> {
  if (!isTauri) return [];
  return invoke<DetectedMeeting[]>("capture_meetings");
}

export async function permissions(): Promise<{ microphone: PermissionState; systemAudio: PermissionState }> {
  if (!isTauri) return { microphone: "unknown", systemAudio: "unknown" };
  return invoke("capture_permissions");
}

export async function requestMicrophone(): Promise<void> {
  if (isTauri) await invoke("capture_request_mic");
}

export async function requestSystemAudio(): Promise<void> {
  if (isTauri) await invoke("capture_request_system_audio");
}

export async function openPrivacySettings(kind: PrivacySettings): Promise<void> {
  if (isTauri) await invoke("open_privacy_settings", { kind });
}

/* ------------------------------------------------------------------ */
/* 飞书 sign-in. The App Secret and tokens stay in the Rust process.   */
/* ------------------------------------------------------------------ */

export type FeishuProfile = {
  name: string;
  enName?: string | null;
  openId: string;
  email?: string | null;
  tenantKey?: string | null;
  /** A data: URL. */
  avatar?: string | null;
};

/** The company this computer signs in to, remembered after signing out. */
export type SavedCompany = { joinCode: string; name: string | null };

export type FeishuStatus = {
  configured: boolean;
  /** Signing in goes through the EchoMind server, which needs the company's join code first. */
  server?: boolean;
  company?: SavedCompany | null;
  /** May open 公司管理. */
  admin?: boolean;
  user: FeishuProfile | null;
  redirectUri: string;
  /** Scopes the saved sign-in lacks (calendar, tasks): signing in again grants them. */
  missingScopes?: string[];
};

/** null in the browser preview, where 飞书 is only a demo. */
export async function feishuStatus(): Promise<FeishuStatus | null> {
  if (!isTauri) return null;
  return invoke<FeishuStatus>("feishu_status");
}

/**
 * Opens Feishu's consent page in the browser and resolves once the person has signed in.
 * `joinCode` picks the company; without it, the one this computer signed in to last.
 */
export async function feishuLogin(joinCode?: string): Promise<FeishuProfile> {
  return invoke<FeishuProfile>("feishu_login", { joinCode: joinCode ?? null });
}

/** Forgets the company, so the next sign-in asks for a join code. */
export async function feishuForgetCompany(): Promise<void> {
  if (isTauri) await invoke("feishu_forget_company");
}

export async function feishuCancel(): Promise<void> {
  if (isTauri) await invoke("feishu_cancel");
}

export async function feishuLogout(): Promise<void> {
  if (isTauri) await invoke("feishu_logout");
}

/* ------------------------------------------------------------------ */
/* 公司管理: only for the people the server lets manage companies.      */
/* ------------------------------------------------------------------ */

export type Company = {
  id: string;
  /** The name registered in Feishu; null until Feishu has told the server. */
  name: string | null;
  appId: string;
  joinCode: string | null;
  /** People who have signed in at least once. */
  people: number;
  disabled: boolean;
  /** The company the server was set up with: the admins' own. */
  isDefault: boolean;
  createdAt: string;
};

/** In the shape of the Feishu console's 批量导入 box. */
export type AppPermissions = { scopes: { tenant: string[]; user: string[] } };

export async function companiesList(): Promise<{ companies: Company[]; permissions: AppPermissions }> {
  return invoke("companies_list");
}

export async function companiesAdd(appId: string, appSecret: string): Promise<Company> {
  return invoke("companies_add", { appId, appSecret });
}

export async function companiesUpdate(id: string, action: "check" | "disable" | "enable"): Promise<Company> {
  return invoke("companies_update", { id, action });
}

export async function companiesReplaceSecret(id: string, appSecret: string): Promise<Company> {
  return invoke("companies_replace_secret", { id, appSecret });
}

/* ------------------------------------------------------------------ */
/* Voiceprints, kept by the server with each person's consent.         */
/* The voices themselves stay in Rust; this page only sees outcomes.   */
/* ------------------------------------------------------------------ */

/** A colleague with a voiceprint or a consent card out (people without one are not listed). */
export type ServerVoiceprint = {
  openId: string;
  status: "asked" | "agreed" | "declined";
  /** A sample has been kept: meetings recognise them. */
  enrolled: boolean;
  samples: number;
  seconds: number;
  askedBy: string | null;
  askedAt: string | null;
  answeredAt: string | null;
};

/** `asked`: a consent card went out; `waiting`: one had already; either way the sample waits for their answer. */
export type RememberOutcome = { status: "saved" | "asked" | "waiting" | "declined"; voiceprint?: ServerVoiceprint };

export type VoiceMatch = { speakerId: string; openId: string; score: number };

export async function voiceprintsList(): Promise<ServerVoiceprint[]> {
  return invoke("voiceprints_list");
}

export async function voiceprintAsk(openId: string, meeting?: string): Promise<ServerVoiceprint> {
  return invoke("voiceprint_ask", { openId, meeting: meeting ?? null });
}

export async function voiceprintDelete(openId: string): Promise<void> {
  await invoke("voiceprint_delete", { openId });
}

export async function voiceprintRemember(meetingId: string, speakerId: string, openId: string, meetingTitle?: string): Promise<RememberOutcome> {
  return invoke("voiceprint_remember", { meetingId, speakerId, openId, meetingTitle: meetingTitle ?? null });
}

/** Who the voices of a transcribed meeting belong to, by the company's voiceprints. */
export async function voicesMatch(meetingId: string): Promise<VoiceMatch[]> {
  return invoke("voices_match", { meetingId });
}

/** A sample that waited for someone's consent went out in the background. */
export function onVoiceprintsChanged(handler: () => void): () => void {
  return isTauri ? subscribe<null>("voiceprints://changed", handler) : () => {};
}

/** Every active member of the company, as people todos can belong to. */
export async function feishuDirectory(refresh = false): Promise<Person[]> {
  return invoke<Person[]>("feishu_directory", { refresh });
}

/** The calendar event this meeting was, if the signed-in user had one at that time. */
export async function feishuMeetingAttendees(start: string, end: string): Promise<{ eventTitle: string; attendeeIds: string[] } | null> {
  return invoke("feishu_meeting_attendees", { start, end });
}

export type NewFeishuTask = { title: string; description?: string; due?: string; assigneeId: string };

export async function feishuCreateTask(task: NewFeishuTask): Promise<{ guid: string; url?: string }> {
  return invoke("feishu_create_task", { task });
}

/* ------------------------------------------------------------------ */
/* Meetings on disk, the DeepSeek proxy, local transcription.          */
/* See docs/desktop-ipc.md.                                            */
/* ------------------------------------------------------------------ */

export async function meetingsList(): Promise<Meeting[]> {
  return invoke<Meeting[]>("meetings_list");
}

export async function meetingSave(meeting: Meeting): Promise<void> {
  await invoke("meeting_save", { meeting });
}

/** `via`: through the EchoMind server (which holds the key), or straight to DeepSeek in debug builds. */
export type LlmStatus = { configured: boolean; model: string; baseUrl: string; via?: "server" | "direct" };

export async function llmStatus(): Promise<LlmStatus | null> {
  if (!isTauri) return null;
  return invoke<LlmStatus>("llm_status");
}

/**
 * A `fetch` for the minutes engine: the request goes out from Rust, which adds the
 * DeepSeek key, so the key never reaches this page.
 */
export async function llmFetch(_url: string, init: RequestInit): Promise<Response> {
  if (init.signal?.aborted) throw init.signal.reason ?? new DOMException("Aborted", "AbortError");
  const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : {};
  const reply = await invoke<{ status: number; body: string }>("llm_chat", { body });
  if (init.signal?.aborted) throw init.signal.reason ?? new DOMException("Aborted", "AbortError");
  return new Response(reply.body, { status: reply.status, headers: { "content-type": "application/json" } });
}

export type ModelInfo = { id: string; name: string; bytes: number; ready: boolean };
export type ModelsStatus = { ready: boolean; downloadBytes: number; models: ModelInfo[] };

export async function transcribeModels(): Promise<ModelsStatus | null> {
  if (!isTauri) return null;
  return invoke<ModelsStatus>("transcribe_models");
}

export async function transcribeDownload(): Promise<void> {
  await invoke("transcribe_download");
}

/** Resolves once listening, so no event sent after it can be missed. */
export async function onModelDownload(handler: (progress: { received: number; total: number }) => void): Promise<() => void> {
  return isTauri ? listen<{ received: number; total: number }>("transcribe://download", (e) => handler(e.payload)) : () => {};
}

export type TranscribeStage = "prepare" | "speech" | "speakers" | "text";

export type TranscribeEvent =
  | { meetingId: string; stage: TranscribeStage; progress: number }
  | { meetingId: string; stage: "done"; transcript: Transcript }
  /** kind: cancelled | models_missing | download | recording | engine | io | app. */
  | { meetingId: string; stage: "error"; kind?: string; message: string };

/** What the user said about a meeting: the scene, and how many people spoke (in the room, or on the other side of a call). */
export type TranscribeHints = { scene: Scene; speakers?: number };

/** With hints, transcribes again as told; without, judges everything from the audio and reuses an earlier run. */
export async function transcribeStart(meetingId: string, hints?: TranscribeHints): Promise<void> {
  await invoke("transcribe_start", { meetingId, scene: hints?.scene ?? null, speakers: hints?.speakers ?? null });
}

/** Resolves once listening: start the transcription after it, or its first events are lost. */
export async function onTranscribe(handler: (event: TranscribeEvent) => void): Promise<() => void> {
  return isTauri ? listen<TranscribeEvent>("transcribe://progress", (e) => handler(e.payload)) : () => {};
}

/** From the floating recorder: bring the main window back. */
export async function showMainWindow(): Promise<void> {
  if (isTauri) await invoke("show_main_window");
}

/** Opens the folder that holds the recordings. */
export async function revealRecordings(): Promise<void> {
  if (isTauri) await invoke("reveal_recordings");
}

/* ------------------------------------------------------------------ */
/* Browser preview: a fake recorder that behaves like the sidecar.     */
/* ------------------------------------------------------------------ */

type Wire = { kind: "event"; event: CaptureEvent } | { kind: "command"; command: CaptureCommand };

class Simulator {
  private channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("echomind-capture") : null;
  private handlers = new Set<(e: CaptureEvent) => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private startedAt = 0;
  private pausedAt: number | null = null;
  private pausedTotal = 0;
  private mic = -60;
  private system = -60;
  private talker: "mic" | "system" = "system";
  private turnLeft = 0;

  constructor() {
    this.channel?.addEventListener("message", (m: MessageEvent<Wire>) => {
      const wire = m.data;
      if (wire.kind === "event") this.handlers.forEach((h) => h(wire.event));
      else if (this.timer) this.command(wire.command);
    });
  }

  subscribe(handler: (e: CaptureEvent) => void) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private emit(event: CaptureEvent) {
    this.handlers.forEach((h) => h(event));
    this.channel?.postMessage({ kind: "event", event } satisfies Wire);
  }

  private elapsed() {
    const now = this.pausedAt ?? Date.now();
    return now - this.startedAt - this.pausedTotal;
  }

  start() {
    if (this.timer) return;
    this.startedAt = Date.now();
    this.pausedAt = null;
    this.pausedTotal = 0;
    this.emit({ type: "started", startedAt: new Date().toISOString(), mic: { device: "MacBook Pro 麦克风（演示）" }, system: { scope: "global" } });
    this.timer = setInterval(() => this.tick(), 100);
  }

  command(command: CaptureCommand) {
    if (!this.timer) {
      this.channel?.postMessage({ kind: "command", command } satisfies Wire);
      return;
    }
    const at = this.elapsed();
    if (command === "mark") this.emit({ type: "mark", atMs: at });
    if (command === "pause" && this.pausedAt === null) {
      this.pausedAt = Date.now();
      this.emit({ type: "paused", atMs: at });
    }
    if (command === "resume" && this.pausedAt !== null) {
      this.pausedTotal += Date.now() - this.pausedAt;
      this.pausedAt = null;
      this.emit({ type: "resumed", atMs: at });
    }
    if (command === "stop") {
      clearInterval(this.timer);
      this.timer = undefined;
      this.emit({ type: "stopped", durationMs: at, segments: Math.max(1, Math.ceil(at / 60000)) });
    }
  }

  /** People take turns; the voice in turn is loud and lively, the other near silence. */
  private tick() {
    if (this.pausedAt !== null) {
      this.emit({ type: "level", t: this.elapsed(), mic: -90, system: -90 });
      return;
    }
    if (--this.turnLeft <= 0) {
      this.talker = Math.random() < 0.35 ? "mic" : "system";
      this.turnLeft = 20 + Math.floor(Math.random() * 40);
    }
    const speaking = () => -26 + Math.random() * 18 - (Math.random() < 0.15 ? 20 : 0);
    const quiet = () => -62 + Math.random() * 8;
    const ease = (from: number, to: number) => from + (to - from) * 0.45;
    this.mic = ease(this.mic, this.talker === "mic" ? speaking() : quiet());
    this.system = ease(this.system, this.talker === "system" ? speaking() : quiet());
    this.emit({ type: "level", t: this.elapsed(), mic: this.mic, system: this.system });
  }
}

const simulator = new Simulator();
