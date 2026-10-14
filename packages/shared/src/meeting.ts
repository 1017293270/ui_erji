import { z } from "zod";

/**
 * The meeting domain shared by the desktop app, the web console and the
 * minutes pipeline. Times inside a meeting are milliseconds from the moment
 * recording started; calendar times are ISO 8601 strings.
 */

/** Where a voice was recorded: the local microphone, or what the computer played. */
export const TrackKind = z.enum(["mic", "system"]);
export type TrackKind = z.infer<typeof TrackKind>;

/** The meeting software, or an in-room meeting recorded by microphone only. */
export const MeetingSource = z.enum(["tencent", "feishu", "zoom", "offline", "other"]);
export type MeetingSource = z.infer<typeof MeetingSource>;

export const MeetingStatus = z.enum([
  "recording", // 录制中
  "transcribing", // 转写中
  "review", // 待确认：纪要已生成，待办等人确认
  "ready", // 已生成
  "pushed", // 已推送到飞书
  "failed",
]);
export type MeetingStatus = z.infer<typeof MeetingStatus>;

/** Someone a todo can belong to: a colleague from the directory, or an outside contact. */
export const Person = z.object({
  id: z.string(),
  name: z.string(),
  feishuOpenId: z.string().optional(),
  department: z.string().optional(),
  title: z.string().optional(),
  /** What people call them in meetings: 小王, 王总, Kevin. */
  aliases: z.array(z.string()).default([]),
  /** Not in the organization; their todos become reminders for the recorder. */
  external: z.boolean().default(false),
  /** Company of an outside contact. */
  company: z.string().optional(),
});
export type Person = z.infer<typeof Person>;

/** How a speaker got their name. */
export const SpeakerSource = z.enum(["self", "voiceprint", "manual", "unknown"]);
export type SpeakerSource = z.infer<typeof SpeakerSource>;

/** A voice in one meeting. Diarization numbers them; people name them. */
export const Speaker = z.object({
  /** Meeting-local id: S1, S2… */
  id: z.string(),
  /** What the transcript shows until the speaker is named: 说话人 1. */
  label: z.string(),
  track: TrackKind,
  personId: z.string().nullable(),
  source: SpeakerSource,
  /** Voiceprint match score, 0–1, when source is voiceprint. */
  confidence: z.number().min(0).max(1).optional(),
});
export type Speaker = z.infer<typeof Speaker>;

/** One utterance in the transcript. */
export const Segment = z.object({
  /** Stable id the minutes cite as evidence: seg-0001. */
  id: z.string(),
  speakerId: z.string(),
  track: TrackKind,
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  text: z.string(),
});
export type Segment = z.infer<typeof Segment>;

/**
 * Where the meeting happened. In person, everyone in the room is on the microphone and
 * told apart by voice; online, the microphone is the person recording.
 */
export const Scene = z.enum(["in-person", "online"]);
export type Scene = z.infer<typeof Scene>;

export const Transcript = z.object({
  meetingId: z.string(),
  language: z.string().default("zh"),
  /** Missing on transcripts from before scenes, which were all treated as online. */
  scene: Scene.optional(),
  speakers: z.array(Speaker),
  segments: z.array(Segment),
});
export type Transcript = z.infer<typeof Transcript>;

/** A statement in the minutes, with the segments that back it up. */
export const Point = z.object({
  text: z.string(),
  evidence: z.array(z.string()).min(1),
});
export type Point = z.infer<typeof Point>;

/** A stretch of the meeting about one topic. */
export const Chapter = z.object({
  id: z.string(),
  title: z.string(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  summary: z.string(),
  firstSegmentId: z.string(),
  lastSegmentId: z.string(),
});
export type Chapter = z.infer<typeof Chapter>;

/** Which model and prompt produced a piece of output, so it can be regenerated and compared. */
export const Generation = z.object({
  provider: z.string(),
  model: z.string(),
  promptVersion: z.string(),
  generatedAt: z.string(),
});
export type Generation = z.infer<typeof Generation>;

export const Minutes = z.object({
  title: z.string(),
  /** One paragraph on what the meeting was about and where it landed. */
  overview: z.string(),
  chapters: z.array(Chapter),
  conclusions: z.array(Point),
  decisions: z.array(Point),
  openQuestions: z.array(Point),
  generation: Generation,
});
export type Minutes = z.infer<typeof Minutes>;

export const TodoStatus = z.enum([
  "draft", // 待确认
  "confirmed", // 已确认，未推送
  "pushed", // 已推送到飞书任务
  "done",
  "delayed",
  "blocked",
]);
export type TodoStatus = z.infer<typeof TodoStatus>;

/** How the owner was worked out; shown next to the owner so people can trust or fix it. */
export const OwnerBasis = z.enum([
  "self-claimed", // 「我来」：说这句话的人
  "assigned", // 「小王你跟一下」：称呼匹配到参会人
  "directory", // 称呼只在通讯录里匹配到
  "unresolved",
]);
export type OwnerBasis = z.infer<typeof OwnerBasis>;

export const Todo = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string().optional(),
  /** How the transcript referred to the owner: 小王, 王总, 我. */
  ownerMention: z.string().nullable(),
  /** The speaker who said it, for self-claimed todos. */
  ownerSpeakerId: z.string().nullable(),
  ownerPersonId: z.string().nullable(),
  ownerBasis: OwnerBasis,
  ownerConfidence: z.number().min(0).max(1),
  /** The owner is outside the company: this becomes a reminder for the recorder. */
  external: z.boolean(),
  /** Due date as said in the meeting: 下周三前. */
  dueText: z.string().nullable(),
  /** That date resolved against the meeting day (YYYY-MM-DD). */
  due: z.string().nullable(),
  evidence: z.array(z.string()).min(1),
  status: TodoStatus,
  feishuTaskId: z.string().optional(),
});
export type Todo = z.infer<typeof Todo>;

export const Meeting = z.object({
  id: z.string(),
  title: z.string(),
  source: MeetingSource,
  status: MeetingStatus,
  startedAt: z.string(),
  durationMs: z.number().nonnegative(),
  /** The person who recorded it. Their microphone is the mic track. */
  recorderId: z.string(),
  participantIds: z.array(z.string()),
  /** Moments the recorder marked as important while recording. */
  marks: z.array(z.number()).default([]),
  transcript: Transcript.optional(),
  minutes: Minutes.optional(),
  todos: z.array(Todo).optional(),
});
export type Meeting = z.infer<typeof Meeting>;
