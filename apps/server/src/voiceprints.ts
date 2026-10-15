import type { Companies } from "./companies";
import { seal, unseal } from "./crypto";
import type { Sql } from "./db";
import type { Card } from "./feishu/messages";
import { sendCard, updateCard } from "./feishu/messages";
import { log } from "./log";
import type { Me } from "./sessions";

/**
 * Voiceprints, so meetings know who is speaking. They are biometric data, so one is kept only
 * after its person agreed: on the consent card the bot sends them, or in their own EchoMind.
 * Deleting one (the person on their card, or any colleague in the app) deletes the consent too.
 *
 * Nothing of a person's voice reaches the server before they agree: the computer that recorded
 * the sample keeps it until then. A voiceprint is the mean of CAM++ embeddings
 * (native/transcriber), sealed at rest. Matching runs here, so voiceprints never leave the server;
 * the voices a computer asks about are compared in memory and dropped, never stored or logged.
 */

export type Status = "asked" | "agreed" | "declined";

/** A voiceprint as the app shows it. People without one have no entry. */
export type Voiceprint = {
  openId: string;
  status: Status;
  /** A sample has been kept: meetings can recognise this person. */
  enrolled: boolean;
  samples: number;
  seconds: number;
  /** Who sent the consent card. */
  askedBy: string | null;
  askedAt: string | null;
  answeredAt: string | null;
};

export type Voice = { speakerId: string; vector: number[]; seconds: number };
export type Match = { speakerId: string; openId: string; score: number };

export type VoiceprintDeps = { sql: Sql; key: Buffer | null; companies: Companies };

/** Something about a voiceprint the caller can act on: `code` for the app, a sentence for people. */
export class VoiceprintError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409 | 429,
    message: string,
  ) {
    super(message);
  }
}

/** Less clean speech than this makes a voiceprint that recognises nobody reliably. */
export const MIN_SAMPLE_SECONDS = 5;
/** A voice in a meeting needs this much speech to be compared at all. */
const MIN_MATCH_SECONDS = 3;
/**
 * Cosine similarity at which a voice is taken for someone, with the runner-up at least MARGIN
 * behind. A wrong name costs more than no name (todos follow the name), so both lean strict.
 */
export const MATCH_THRESHOLD = 0.6;
const MATCH_MARGIN = 0.05;
/** A new sample this far from the voiceprint is someone else's voice: a speaker named wrongly. */
const SAME_PERSON_MIN = 0.3;
/** Old samples count for at most this many seconds, so a voiceprint keeps adapting. */
const MEMORY_SECONDS = 300;
/** One sample counts for at most a minute, like the transcriber's own voiceprints. */
const SAMPLE_MAX_SECONDS = 60;
/** A person gets at most one consent card a day. */
const ASK_AGAIN_MS = 24 * 3_600_000;
/**
 * Feishu waits 3 seconds for the answer to a button press, then tells the person it failed. An
 * answer that cannot be written by then is not written at all.
 */
const ANSWER_WITHIN_MS = 2_500;

// ---------------------------------------------------------------------------
// Vectors

const aad = (personId: string) => `voiceprint:${personId}`;

/** Unit length; null for anything that is not a usable embedding. */
export function normalized(vector: readonly number[]): Float32Array | null {
  if (vector.length < 64 || vector.length > 1024) return null;
  // Scaled to the largest value first, so squaring neither overflows nor underflows.
  let largest = 0;
  for (const x of vector) {
    if (!Number.isFinite(x)) return null;
    largest = Math.max(largest, Math.abs(x));
  }
  if (!(largest > 0)) return null;
  const scaled = vector.map((x) => x / largest);
  const norm = Math.sqrt(scaled.reduce((sum, x) => sum + x * x, 0));
  return Float32Array.from(scaled, (x) => x / norm);
}

const dot = (a: Float32Array, b: Float32Array) => a.reduce((sum, x, i) => sum + x * b[i]!, 0);

function sealVector(key: Buffer, personId: string, v: Float32Array): Buffer {
  return seal(key, Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64"), aad(personId));
}

function openVector(key: Buffer, personId: string, sealed: Uint8Array): Float32Array {
  const bytes = Buffer.from(unseal(key, sealed, aad(personId)), "base64");
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function needKey(deps: VoiceprintDeps): Buffer {
  if (!deps.key) throw new Error("服务器还没有配置 ECHOMIND_DATA_KEY，不能保存声纹：请管理员处理。");
  return deps.key;
}

// ---------------------------------------------------------------------------
// Reading

type Row = {
  personId: string;
  openId: string;
  name: string;
  status: Status;
  askedByName: string | null;
  askedAt: Date | null;
  answeredAt: Date | null;
  cardMessageId: string | null;
  vector: Uint8Array | null;
  samples: number;
  seconds: number;
};

function select(sql: Sql, tenantId: string, openId?: string) {
  return sql<Row[]>`
    select v.person_id, p.open_id, p.name, v.status, a.name as asked_by_name, v.asked_at, v.answered_at,
      v.card_message_id, v.vector, v.samples, v.seconds
    from voiceprints v join people p on p.id = v.person_id left join people a on a.id = v.asked_by
    where p.tenant_id = ${tenantId} ${openId ? sql`and p.open_id = ${openId}` : sql``}
    order by p.sort_order, p.name`;
}

function shown(row: Row): Voiceprint {
  return {
    openId: row.openId,
    status: row.status,
    enrolled: !!row.vector,
    samples: row.samples,
    seconds: Math.round(row.seconds),
    askedBy: row.askedByName,
    askedAt: row.askedAt?.toISOString() ?? null,
    answeredAt: row.answeredAt?.toISOString() ?? null,
  };
}

export async function listVoiceprints(sql: Sql, tenantId: string): Promise<Voiceprint[]> {
  return (await select(sql, tenantId)).map(shown);
}

async function voiceprintOf(sql: Sql, tenantId: string, openId: string): Promise<Voiceprint | null> {
  const [row] = await select(sql, tenantId, openId);
  return row ? shown(row) : null;
}

/** A colleague in the caller's company. */
async function colleague(sql: Sql, tenantId: string, openId: string): Promise<{ id: string; name: string }> {
  const [person] = await sql<{ id: string; name: string }[]>`select id, name from people where tenant_id = ${tenantId} and open_id = ${openId}`;
  if (!person) throw new VoiceprintError("not_found", 404, "通讯录里没有这个人：请先在「设置」里刷新飞书通讯录。");
  return person;
}

// ---------------------------------------------------------------------------
// Consent

/** Sends `openId` the consent card, on behalf of `me`. `meeting` says where their voice came from. */
export async function askConsent(deps: VoiceprintDeps, me: Me, openId: string, meeting: string | null): Promise<Voiceprint> {
  if (openId === me.openId) {
    throw new VoiceprintError("self", 400, "这是你自己：在会议里给自己命名时勾选「记住我的声音」就行，不用发卡片。");
  }
  const person = await colleague(deps.sql, me.tenantId, openId);
  const current = await voiceprintOf(deps.sql, me.tenantId, openId);
  if (current?.status === "agreed") return current;
  if (current?.askedAt && Date.parse(current.askedAt) > Date.now() - ASK_AGAIN_MS) {
    throw new VoiceprintError("asked_recently", 429, `24 小时内已经给${person.name}发过同意卡片了，等${person.name}回复就行。`);
  }
  const feishu = await deps.companies.feishu(me.tenantId);
  const sending = (await deps.sql<{ now: Date }[]>`select now()`)[0]!.now;
  const messageId = await sendCard(feishu, openId, consentCard("asked", openId, { asker: me.name, meeting }));
  // An answer given meanwhile stands: agreeing in their own app, or pressing a button on this
  // very card before Feishu said it was sent.
  await deps.sql`
    insert into voiceprints (person_id, status, asked_by, asked_at, card_message_id)
    values (${person.id}, 'asked', ${me.personId}, now(), ${messageId})
    on conflict (person_id) do update set
      status = case when voiceprints.status = 'agreed' or voiceprints.answered_at >= ${sending} then voiceprints.status else 'asked' end,
      answered_at = case when voiceprints.status = 'agreed' or voiceprints.answered_at >= ${sending} then voiceprints.answered_at end,
      asked_by = excluded.asked_by, asked_at = excluded.asked_at, card_message_id = excluded.card_message_id,
      updated_at = now()`;
  log("info", "已发送声纹同意卡片", { tenant: me.tenantId, person: person.id, by: me.personId });
  return (await voiceprintOf(deps.sql, me.tenantId, openId))!;
}

/**
 * Adds a voice sample to `openId`'s voiceprint. Someone else's needs their consent first; a
 * sample of the caller's own voice is their consent.
 */
export async function addSample(deps: VoiceprintDeps, me: Me, openId: string, sample: { vector: number[]; seconds: number }): Promise<Voiceprint> {
  const key = needKey(deps);
  const vector = normalized(sample.vector);
  if (!vector) throw new VoiceprintError("bad_voice", 400, "这段声音的声纹数据不完整，请重新转写这场会议后再试。");
  if (!(sample.seconds >= MIN_SAMPLE_SECONDS)) {
    throw new VoiceprintError("too_short", 400, `这段声音太短了（不到 ${MIN_SAMPLE_SECONDS} 秒），记不住：等一场说得多一些的会议再试。`);
  }
  const seconds = Math.min(sample.seconds, SAMPLE_MAX_SECONDS);
  const person = await colleague(deps.sql, me.tenantId, openId);
  const self = openId === me.openId;

  await deps.sql.begin(async (tx) => {
    // The person's row, not the voiceprint's: there is none before the first sample, and two
    // first samples at once must not both start from nothing.
    await tx`select 1 from people where id = ${person.id} for no key update`;
    const [row] = await tx<Pick<Row, "status" | "vector" | "seconds">[]>`
      select status, vector, seconds from voiceprints where person_id = ${person.id}`;
    if (!self && row?.status !== "agreed") {
      throw new VoiceprintError("consent_needed", 409, `${person.name}还没有同意保存声纹。`);
    }
    let merged = vector;
    if (row?.vector) {
      const current = openVector(key, person.id, row.vector);
      // Another embedding model: start again from this sample.
      if (current.length === vector.length) {
        if (dot(current, vector) < SAME_PERSON_MIN) {
          throw new VoiceprintError("not_same_person", 409, `这段声音和${person.name}已保存的声纹差别很大，没有加进去：请确认没有标错人。`);
        }
        const weight = Math.min(row.seconds, MEMORY_SECONDS);
        merged = normalized(Array.from(current, (x, i) => x * weight + vector[i]! * seconds)) ?? vector;
      }
    }
    const sealed = sealVector(key, person.id, merged);
    await tx`
      insert into voiceprints (person_id, status, answered_at, vector, samples, seconds)
      values (${person.id}, 'agreed', now(), ${sealed}, 1, ${seconds})
      on conflict (person_id) do update set
        status = 'agreed',
        answered_at = case when voiceprints.status = 'agreed' then voiceprints.answered_at else now() end,
        vector = excluded.vector, samples = voiceprints.samples + 1, seconds = voiceprints.seconds + excluded.seconds,
        updated_at = now()`;
  });
  log("info", "声纹已加入一段声音", { tenant: me.tenantId, person: person.id, by: me.personId, self });
  return (await voiceprintOf(deps.sql, me.tenantId, openId))!;
}

/** Deletes a voiceprint and its consent. Their card, if any, says so too. */
export async function deleteVoiceprint(deps: VoiceprintDeps, me: Me, openId: string): Promise<void> {
  const person = await colleague(deps.sql, me.tenantId, openId);
  const [row] = await deps.sql<{ cardMessageId: string | null }[]>`delete from voiceprints where person_id = ${person.id} returning card_message_id`;
  if (!row) return;
  log("info", "已删除声纹", { tenant: me.tenantId, person: person.id, by: me.personId });
  if (!row.cardMessageId) return;
  try {
    await updateCard(await deps.companies.feishu(me.tenantId), row.cardMessageId, consentCard("deleted", openId));
  } catch (e) {
    log("info", "没能更新声纹同意卡片", { tenant: me.tenantId, err: e instanceof Error ? e.message : String(e) });
  }
}

// ---------------------------------------------------------------------------
// Recognising voices

/**
 * Which colleagues the voices of one meeting belong to. Each person answers for at most one
 * voice, and only a clear winner counts.
 */
export async function matchVoices(deps: VoiceprintDeps, me: Me, voices: Voice[]): Promise<Match[]> {
  const key = needKey(deps);
  const rows = await deps.sql<{ personId: string; openId: string; vector: Uint8Array }[]>`
    select v.person_id, p.open_id, v.vector from voiceprints v join people p on p.id = v.person_id
    where p.tenant_id = ${me.tenantId} and v.status = 'agreed' and v.vector is not null`;
  const prints = rows.map((r) => ({ openId: r.openId, vector: openVector(key, r.personId, r.vector) }));

  const candidates: Match[] = [];
  for (const voice of voices) {
    const vector = voice.seconds >= MIN_MATCH_SECONDS ? normalized(voice.vector) : null;
    if (!vector) continue;
    const scores = prints
      .filter((p) => p.vector.length === vector.length)
      .map((p) => ({ openId: p.openId, score: dot(p.vector, vector) }))
      .sort((a, b) => b.score - a.score);
    const [best, next] = scores;
    if (best && best.score >= MATCH_THRESHOLD && best.score - (next?.score ?? -1) >= MATCH_MARGIN) {
      candidates.push({ speakerId: voice.speakerId, openId: best.openId, score: Math.round(best.score * 100) / 100 });
    }
  }
  const matches: Match[] = [];
  for (const c of candidates.sort((a, b) => b.score - a.score)) {
    if (matches.some((m) => m.speakerId === c.speakerId || m.openId === c.openId)) continue;
    matches.push(c);
  }
  return matches;
}

// ---------------------------------------------------------------------------
// The consent card

export type CardState = "asked" | "agreed" | "declined" | "deleted";
export type CardAction = "agree" | "decline" | "delete";

/** What a button sends back: the action, and whose card it is. */
type ButtonValue = { voiceprint: CardAction; person: string };

const button = (label: string, type: "primary" | "default" | "danger", action: CardAction, person: string) => ({
  tag: "button",
  text: { tag: "plain_text", content: label },
  type,
  value: { voiceprint: action, person } satisfies ButtonValue,
});

const markdown = (content: string) => ({ tag: "div", text: { tag: "lark_md", content } });
/** For what people typed (names, meeting titles): no links or mentions in a card from the bot. */
const plain = (content: string) => ({ tag: "div", text: { tag: "plain_text", content } });

/** The card the bot sends to ask for consent, in each of its states. */
export function consentCard(state: CardState, person: string, asked?: { asker: string; meeting: string | null }): Card {
  const card = (template: string, title: string, elements: unknown[]): Card => ({
    config: { wide_screen_mode: true, update_multi: true },
    header: { template, title: { tag: "plain_text", content: title } },
    elements,
  });
  switch (state) {
    case "asked": {
      const where = asked?.meeting ? `在会议「${asked.meeting}」里把一段声音标成了你` : "邀请你在 EchoMind 里建立声纹";
      return card("orange", "EchoMind 想记住你的声音", [
        plain(`${asked?.asker ?? "同事"}${where}。`),
        markdown(
          "同意后，EchoMind 会保存你的**声纹**：一串描述声音特点的数字，不是录音，也听不出你说了什么。以后开会，EchoMind 能自动认出是你在说话，把你认领的待办记到你名下。",
        ),
        markdown("· 只在你们公司的 EchoMind 里使用\n· 随时可以在这张卡片上删除\n· 不同意也不影响你开会和使用飞书"),
        { tag: "action", actions: [button("同意", "primary", "agree", person), button("不同意", "default", "decline", person)] },
      ]);
    }
    case "agreed":
      return card("green", "你已同意保存声纹", [
        markdown("以后开会，EchoMind 会认出你的声音。想删除的话，点下面的按钮，你的声纹会马上删除。"),
        { tag: "action", actions: [button("删除我的声纹", "danger", "delete", person)] },
      ]);
    case "declined":
      return card("grey", "你没有同意保存声纹", [
        markdown("EchoMind 不会保存你的声纹。改主意了可以点「同意」。"),
        { tag: "action", actions: [button("同意", "primary", "agree", person)] },
      ]);
    case "deleted":
      return card("grey", "你的声纹已删除", [
        markdown("EchoMind 已经删除了你的声纹。以后想让 EchoMind 认出你，可以点「同意」。"),
        { tag: "action", actions: [button("同意", "primary", "agree", person)] },
      ]);
  }
}

/** What the card callback answers: a toast, and the card in its new state. */
export type CardReply = { toast: { type: "success" | "info" | "error"; content: string }; card?: { type: "raw"; data: Card } };

const ACTIONS: readonly CardAction[] = ["agree", "decline", "delete"];

/**
 * A button pressed on a consent card, as Feishu's card.action.trigger callback delivers it on
 * the company's long connection. Only the person the card is about can answer it.
 */
export async function answerCard(
  deps: VoiceprintDeps,
  tenantId: string,
  event: { operatorOpenId: string | undefined; value: unknown },
  deadline = Date.now() + ANSWER_WITHIN_MS,
): Promise<CardReply> {
  const value = (event.value ?? {}) as Partial<ButtonValue>;
  const action = ACTIONS.find((a) => a === value.voiceprint);
  if (!action || typeof value.person !== "string") return { toast: { type: "error", content: "这张卡片已经过期了。" } };
  if (event.operatorOpenId !== value.person) return { toast: { type: "error", content: "只有本人能回答这张卡片。" } };
  const openId = value.person;

  const answered = await deps.sql.begin(async (tx) => {
    // A query stuck behind a lock gives up in time too.
    await tx`select set_config('statement_timeout', ${String(Math.max(deadline - Date.now(), 1))}, true)`;
    const [person] = await tx<{ id: string }[]>`select id from people where tenant_id = ${tenantId} and open_id = ${openId}`;
    if (!person) return null;
    if (action === "agree") {
      await tx`
        insert into voiceprints (person_id, status, answered_at) values (${person.id}, 'agreed', now())
        on conflict (person_id) do update set status = 'agreed',
          answered_at = case when voiceprints.status = 'agreed' then voiceprints.answered_at else now() end, updated_at = now()`;
    } else if (action === "decline") {
      // Declining on a card that has gone stale also drops whatever was kept since.
      await tx`
        insert into voiceprints (person_id, status, answered_at) values (${person.id}, 'declined', now())
        on conflict (person_id) do update set status = 'declined', answered_at = now(), vector = null, samples = 0, seconds = 0, updated_at = now()`;
    } else {
      await tx`delete from voiceprints where person_id = ${person.id}`;
    }
    // Feishu has told them it failed by now: undone, so what they saw is what happened.
    if (Date.now() > deadline) throw new Error("声纹同意卡片的回答没能及时写入");
    return person;
  });
  if (!answered) return { toast: { type: "error", content: "EchoMind 里找不到你的账号，请联系管理员。" } };

  const [state, toast]: [CardState, string] =
    action === "agree" ? ["agreed", "已同意，谢谢！"] : action === "decline" ? ["declined", "好的，EchoMind 不会保存你的声纹。"] : ["deleted", "已删除你的声纹。"];
  log("info", "声纹同意卡片已回答", { tenant: tenantId, person: answered.id, action });
  return { toast: { type: "success", content: toast }, card: { type: "raw", data: consentCard(state, openId) } };
}
