import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Meeting, Person, Transcript } from "@echomind/shared";

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

export type FeishuStatus = {
  configured: boolean;
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

/** Opens Feishu's consent page in the browser and resolves once the person has signed in. */
export async function feishuLogin(): Promise<FeishuProfile> {
  return invoke<FeishuProfile>("feishu_login");
}

export async function feishuCancel(): Promise<void> {
  if (isTauri) await invoke("feishu_cancel");
}

export async function feishuLogout(): Promise<void> {
  if (isTauri) await invoke("feishu_logout");
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

export async function transcribeStart(meetingId: string): Promise<void> {
  await invoke("transcribe_start", { meetingId });
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
