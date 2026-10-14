import type { OwnerBasis, Person, Segment, Speaker } from "@echomind/shared";

/**
 * Works out who owns a todo from what the model quoted, in code, so every
 * owner can be explained and trusted or fixed:
 *
 *  - 「我 / 我来 / 我这边」 → the speaker of the line that claimed it (self-claimed)
 *  - a name or alias of a participant (exact, then contained, then without
 *    honorifics like 总 / 经理 / 哥 / 姐) → that participant (assigned)
 *  - the same, matched only in the company directory → that person (directory)
 *  - otherwise, or ambiguous, or claimed by a voice nobody has named → unresolved
 *
 * When a named owner then says 「我…」 themselves in the evidence
 * (「赵总您批一下」「我这周内批掉」), the todo counts as self-claimed.
 */

export interface OwnerInput {
  /** How the transcript referred to the owner, as quoted by the model. */
  ownerMention: string | null;
  /** The line that assigned or claimed the todo. */
  ownerSegmentId: string | null;
  evidence: readonly string[];
}

export interface OwnerContext {
  segments: ReadonlyMap<string, Segment>;
  speakers: readonly Speaker[];
  participants: readonly Person[];
  directory: readonly Person[];
}

export interface OwnerResolution {
  ownerMention: string | null;
  /** The speaker whose line established the owner: the claimer, or whoever assigned it. */
  ownerSpeakerId: string | null;
  ownerPersonId: string | null;
  ownerBasis: OwnerBasis;
  ownerConfidence: number;
  external: boolean;
  /** Why, in Chinese: for logs and the 「依据」 tooltip. */
  reason: string;
}

type Quality = "exact" | "contains" | "honorific" | "surname";

interface Match {
  person: Person;
  quality: Quality;
}

type Lookup = { kind: "found"; match: Match } | { kind: "ambiguous"; people: Person[]; quality: Quality } | { kind: "none" };

const CONFIDENCE: Record<"assigned" | "directory", Record<Quality, number>> = {
  assigned: { exact: 0.9, contains: 0.85, honorific: 0.8, surname: 0.7 },
  directory: { exact: 0.85, contains: 0.75, honorific: 0.7, surname: 0.55 },
};

const SELF = /^(我|俺|本人)(?!们)/;
const TEAM = /^(我们|咱们|咱)/;
const SECOND_PERSON = /^(你|您)/;
const NOBODY = /^(null|none|无|没有|没人|暂无|待定|未定|未知|不详|谁|大家)$/i;
const REFUSAL = /(没空|没时间|排满|做不了|来不及|不太行|搞不定|看看别人|找别人|不是我|别找我)/;
const ACCEPT = /^[，,。\s]*(好|好的|行|可以|没问题|收到|ok|妥|明白)/i;

/** A first-person commitment in a line: 「我来」「我这周内批掉」, but not 「我这两周排满了」. */
/** Whether a mention is the speaker claiming the todo: 「我」 alone, or 「我们」 for the team. */
export function selfMention(mention: string | null): "self" | "team" | null {
  const m = mention?.trim() ?? "";
  return SELF.test(m) ? "self" : TEAM.test(m) ? "team" : null;
}

export function claimsFirstPerson(text: string): boolean {
  return /[我俺](?!们)/.test(text) && !REFUSAL.test(text);
}

export function resolveOwner(input: OwnerInput, ctx: OwnerContext): OwnerResolution {
  const raw = input.ownerMention?.trim().replace(/^[「“"']+|[」”"']+$/g, "") ?? "";
  const mention = raw && !NOBODY.test(raw) ? raw : null;
  const evidence = [input.ownerSegmentId, ...input.evidence]
    .filter((id): id is string => !!id && ctx.segments.has(id))
    .filter((id, i, all) => all.indexOf(id) === i);
  const lineId = input.ownerSegmentId && ctx.segments.has(input.ownerSegmentId) ? input.ownerSegmentId : evidence[0];
  const line = lineId ? ctx.segments.get(lineId) : undefined;
  const speakerOf = (seg: Segment | undefined) => (seg ? ctx.speakers.find((s) => s.id === seg.speakerId) : undefined);
  const lineSpeaker = speakerOf(line);
  const base = { ownerMention: mention, external: false };

  if (!mention) {
    return { ...base, ownerSpeakerId: null, ownerPersonId: null, ownerBasis: "unresolved", ownerConfidence: 0.2, reason: "会上没有明确负责人" };
  }

  if (selfMention(mention)) {
    const team = selfMention(mention) === "team";
    // Trust the cited line only if it is in the first person; otherwise look for the claim in the evidence.
    let claimLine = line && claimsFirstPerson(line.text) ? line : undefined;
    claimLine ??= evidence.map((id) => ctx.segments.get(id)!).find((s) => claimsFirstPerson(s.text));
    const speaker = speakerOf(claimLine) ?? lineSpeaker;
    if (!speaker) {
      return { ...base, ownerSpeakerId: null, ownerPersonId: null, ownerBasis: "unresolved", ownerConfidence: 0.25, reason: "找不到说「我」的那句话" };
    }
    if (!speaker.personId) {
      return {
        ...base,
        ownerSpeakerId: speaker.id,
        ownerPersonId: null,
        ownerBasis: "unresolved",
        ownerConfidence: 0.5,
        reason: `${speaker.label}认领了，但这位说话人还没有对应到人`,
      };
    }
    const person = findPerson(speaker.personId, ctx);
    let confidence = Math.min(team ? 0.6 : 0.95, voiceTrust(speaker));
    if (!claimLine) confidence = Math.min(confidence, 0.6);
    return {
      ...base,
      ownerSpeakerId: speaker.id,
      ownerPersonId: speaker.personId,
      ownerBasis: "self-claimed",
      ownerConfidence: round(confidence),
      external: person?.external ?? false,
      reason: `${person?.name ?? speaker.label}自己认领（「${mention}」）${team ? "，说的是「我们」，按说话人本人算" : ""}`,
    };
  }

  const name = cleanMention(mention);
  if (SECOND_PERSON.test(name) || !name) {
    return {
      ...base,
      ownerSpeakerId: lineSpeaker?.id ?? null,
      ownerPersonId: null,
      ownerBasis: "unresolved",
      ownerConfidence: 0.3,
      reason: `称呼「${mention}」没有指明是谁`,
    };
  }

  const found = matchMention(name, ctx);
  if (found.kind !== "found") {
    return {
      ...base,
      ownerSpeakerId: lineSpeaker?.id ?? null,
      ownerPersonId: null,
      ownerBasis: "unresolved",
      ownerConfidence: 0.3,
      reason:
        found.kind === "ambiguous"
          ? `称呼「${mention}」可能是${found.people.map((p) => p.name).join("、")}，需要人工确认`
          : `称呼「${mention}」没有匹配到参会人或通讯录`,
    };
  }

  const { person, quality } = found.match;
  const isParticipant = ctx.participants.some((p) => p.id === person.id);
  const basis = isParticipant ? "assigned" : "directory";
  let confidence = CONFIDENCE[basis][quality];
  let reason = `称呼「${mention}」${quality === "exact" ? "" : "近似"}匹配到${isParticipant ? "参会人" : "通讯录中的"}${person.name}`;

  // Did the owner answer in their own voice?
  const ownSpeakers = new Set(ctx.speakers.filter((s) => s.personId === person.id).map((s) => s.id));
  const ownLines = evidence.map((id) => ctx.segments.get(id)!).filter((s) => ownSpeakers.has(s.speakerId));
  const claim = ownLines.find((s) => claimsFirstPerson(s.text));
  if (claim) {
    const speaker = speakerOf(claim)!;
    return {
      ...base,
      ownerSpeakerId: speaker.id,
      ownerPersonId: person.id,
      ownerBasis: "self-claimed",
      ownerConfidence: round(Math.min(0.92, voiceTrust(speaker))),
      external: person.external,
      reason: `${reason}，本人随后认领（${claim.id}）`,
    };
  }
  if (ownLines.some((s) => REFUSAL.test(s.text))) {
    confidence -= 0.2;
    reason += "，但本人表示有困难";
  } else if (ownLines.some((s) => ACCEPT.test(s.text))) {
    confidence += 0.03;
    reason += "，本人已答应";
  }
  return {
    ...base,
    ownerSpeakerId: lineSpeaker?.id ?? null,
    ownerPersonId: person.id,
    ownerBasis: basis,
    ownerConfidence: round(Math.max(0.3, Math.min(0.95, confidence))),
    external: person.external,
    reason,
  };
}

/** How much a speaker's name can be trusted: set by the recorder or by hand is solid, a voiceprint is a score. */
function voiceTrust(speaker: Speaker): number {
  switch (speaker.source) {
    case "self":
    case "manual":
      return 1;
    case "voiceprint":
      return 0.6 + 0.4 * (speaker.confidence ?? 0.75);
    case "unknown":
      return 0.6;
  }
}

function findPerson(id: string, ctx: OwnerContext): Person | undefined {
  return ctx.participants.find((p) => p.id === id) ?? ctx.directory.find((p) => p.id === id);
}

const round = (n: number) => Math.round(n * 100) / 100;

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s·•._-]/g, "");

/** 小王你 → 小王, 孙经理那边 → 孙经理, 「娜娜」 → 娜娜. */
export function cleanMention(mention: string): string {
  let s = norm(mention).replace(/[，,。:：!！?？、]/g, "");
  for (let i = 0; i < 2; i++) s = s.replace(/(你们|你|您|他们|他|她|同学|那边|这边|那里|这里|团队|负责)$/, "");
  return s;
}

const HONORIFIC = /(总经理|总监|总裁|经理|主管|主任|部长|老师|老板|博士|教授|总|工|哥|姐|姐姐|哥哥|姐儿|老大)$/;
const FAMILIAR = /^(小|老|阿)/;

/** 王总 → 王, 磊哥 → 磊, 老赵 → 赵, 孙经理 → 孙. */
function core(s: string): string {
  const stripped = s.replace(HONORIFIC, "").replace(FAMILIAR, "");
  return stripped.length ? stripped : s;
}

function matchMention(name: string, ctx: OwnerContext): Lookup {
  const participantIds = new Set(ctx.participants.map((p) => p.id));
  const inMeeting = lookup(name, ctx.participants);
  const strong = (l: Lookup) => l.kind !== "none" && (l.kind === "found" ? l.match.quality : l.quality) !== "surname";
  if (strong(inMeeting)) return inMeeting;
  // 「孙经理」 is exactly someone in the directory; a participant who merely shares the surname should not win.
  const outside = lookup(
    name,
    ctx.directory.filter((p) => !participantIds.has(p.id)),
  );
  if (outside.kind === "found" && outside.match.quality === "exact") return outside;
  if (inMeeting.kind !== "none") return inMeeting;
  return outside;
}

function lookup(name: string, people: readonly Person[]): Lookup {
  const tiers: Quality[] = ["exact", "contains", "honorific", "surname"];
  for (const quality of tiers) {
    const hits = people.filter((p) => matches(name, p, quality));
    const unique = hits.filter((p, i) => hits.findIndex((q) => q.id === p.id) === i);
    if (unique.length === 1) return { kind: "found", match: { person: unique[0]!, quality } };
    if (unique.length > 1) return { kind: "ambiguous", people: unique, quality };
  }
  return { kind: "none" };
}

function matches(name: string, person: Person, quality: Quality): boolean {
  const full = norm(person.name);
  const aliases = (person.aliases ?? []).map(norm);
  const forms = [full, ...aliases];
  switch (quality) {
    case "exact":
      return forms.includes(name);
    case "contains":
      return name.length >= 2 && forms.some((f) => f.length >= 2 && (f.includes(name) || name.includes(f)));
    case "honorific": {
      const c = core(name);
      return c.length >= 2 && (full.includes(c) || aliases.some((a) => core(a) === c));
    }
    case "surname": {
      const c = core(name);
      if (c.length !== 1) return false;
      return full.startsWith(c) || (full.length <= 3 && full.endsWith(c)) || aliases.some((a) => core(a) === c);
    }
  }
}
