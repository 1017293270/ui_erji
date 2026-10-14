import { describe, expect, it } from "vitest";
import type { Person, Segment } from "@echomind/shared";
import { people, reviewMeeting, reviewSegments, reviewSpeakers, reviewTodos } from "@echomind/shared/fixtures";
import { cleanMention, resolveOwner, selfMention, type OwnerContext } from "./owner";

const participants = people.filter((p) => reviewMeeting.participantIds.includes(p.id));

/** A tiny transcript: each line is [speakerId, text]; ids are seg-1, seg-2… */
function ctxFor(lines: [string, string][], extra: Partial<OwnerContext> = {}): OwnerContext {
  const segments: Segment[] = lines.map(([speakerId, text], i) => ({
    id: `seg-${i + 1}`,
    speakerId,
    track: speakerId === "S1" ? "mic" : "system",
    start: i * 10_000,
    end: i * 10_000 + 5_000,
    text,
  }));
  return {
    segments: new Map(segments.map((s) => [s.id, s])),
    speakers: reviewSpeakers,
    participants,
    directory: people,
    ...extra,
  };
}

const fixtureCtx: OwnerContext = {
  segments: new Map(reviewSegments.map((s) => [s.id, s])),
  speakers: reviewSpeakers,
  participants,
  directory: people,
};

describe("resolveOwner", () => {
  it("「小王你跟一下」 said by S1 → 王磊, assigned", () => {
    const ctx = ctxFor([["S1", "这个问题小王你跟一下。"]]);
    const r = resolveOwner({ ownerMention: "小王", ownerSegmentId: "seg-1", evidence: ["seg-1"] }, ctx);
    expect(r).toMatchObject({
      ownerPersonId: "p-wang",
      ownerBasis: "assigned",
      ownerSpeakerId: "S1",
      external: false,
      ownerMention: "小王",
    });
    expect(r.ownerConfidence).toBe(0.9);
  });

  it("strips the 你 the model sometimes keeps: 「小王你」", () => {
    const ctx = ctxFor([["S1", "这个问题小王你跟一下。"]]);
    const r = resolveOwner({ ownerMention: "小王你", ownerSegmentId: "seg-1", evidence: ["seg-1"] }, ctx);
    expect(r.ownerPersonId).toBe("p-wang");
    expect(r.ownerBasis).toBe("assigned");
  });

  it("「这个我来」 said by S2 → 王磊, self-claimed", () => {
    const ctx = ctxFor([
      ["S1", "这个谁来跟？"],
      ["S2", "这个我来。"],
    ]);
    const r = resolveOwner({ ownerMention: "我", ownerSegmentId: "seg-2", evidence: ["seg-1", "seg-2"] }, ctx);
    expect(r).toMatchObject({ ownerPersonId: "p-wang", ownerBasis: "self-claimed", ownerSpeakerId: "S2", external: false });
    // S2 is named by voiceprint (0.91), so not quite as sure as the recorder's own mic.
    expect(r.ownerConfidence).toBeGreaterThanOrEqual(0.9);
    expect(r.ownerConfidence).toBeLessThanOrEqual(0.95);
  });

  it("variants of 我 all count as a self claim: 我来 / 我这边", () => {
    const ctx = ctxFor([["S2", "Mac 这边我来做。"]]);
    for (const mention of ["我来", "我这边", "我自己"]) {
      const r = resolveOwner({ ownerMention: mention, ownerSegmentId: "seg-1", evidence: ["seg-1"] }, ctx);
      expect(r.ownerBasis, mention).toBe("self-claimed");
      expect(r.ownerPersonId, mention).toBe("p-wang");
    }
  });

  describe("「赵总您批一下」 + 「我这周内批掉」 → 赵建国", () => {
    const ctx = ctxFor([
      ["S1", "这个需要赵总您这边批一下采购，我把清单发您。"],
      ["S4", "行，你发我，我这周内批掉。"],
    ]);

    it("from the mention 赵总: assigned, then claimed in his own voice", () => {
      const r = resolveOwner({ ownerMention: "赵总", ownerSegmentId: "seg-1", evidence: ["seg-1", "seg-2"] }, ctx);
      expect(r).toMatchObject({ ownerPersonId: "p-zhao", ownerBasis: "self-claimed", ownerSpeakerId: "S4", ownerMention: "赵总" });
      expect(r.ownerConfidence).toBe(0.92);
    });

    it("from the mention 我 on his line", () => {
      const r = resolveOwner({ ownerMention: "我", ownerSegmentId: "seg-2", evidence: ["seg-1", "seg-2"] }, ctx);
      expect(r).toMatchObject({ ownerPersonId: "p-zhao", ownerBasis: "self-claimed", ownerSpeakerId: "S4" });
      expect(r.ownerConfidence).toBe(0.95);
    });

    it("stays assigned when the cited evidence lacks his reply", () => {
      const r = resolveOwner({ ownerMention: "赵总", ownerSegmentId: "seg-1", evidence: ["seg-1"] }, ctx);
      expect(r).toMatchObject({ ownerPersonId: "p-zhao", ownerBasis: "assigned", ownerSpeakerId: "S1", ownerConfidence: 0.9 });
    });
  });

  it("external 孙经理, not in the meeting → directory, external", () => {
    const r = resolveOwner({ ownerMention: "孙经理", ownerSegmentId: "seg-0044", evidence: ["seg-0044"] }, fixtureCtx);
    expect(r).toMatchObject({
      ownerPersonId: "p-sun",
      ownerBasis: "directory",
      external: true,
      ownerSpeakerId: "S1",
    });
    expect(r.ownerConfidence).toBe(0.85);
  });

  it("an external contact who is in the meeting is assigned, still external", () => {
    const ctx = ctxFor([["S1", "孙经理那边帮忙开一下测试账号。"]], { participants: [...participants, people.find((p) => p.id === "p-sun")!] });
    const r = resolveOwner({ ownerMention: "孙经理那边", ownerSegmentId: "seg-1", evidence: ["seg-1"] }, ctx);
    expect(r).toMatchObject({ ownerPersonId: "p-sun", ownerBasis: "assigned", external: true });
  });

  it("nobody → unresolved", () => {
    const ctx = ctxFor([
      ["S4", "私有化那个调研，谁有空先看一下？"],
      ["S2", "我这两周排满了，可能要看看别人。"],
      ["S1", "那这个先挂着，我回头找人。"],
    ]);
    for (const mention of [null, "", "null", "待定"]) {
      const r = resolveOwner({ ownerMention: mention, ownerSegmentId: "seg-1", evidence: ["seg-1", "seg-2", "seg-3"] }, ctx);
      expect(r).toMatchObject({ ownerPersonId: null, ownerSpeakerId: null, ownerBasis: "unresolved", ownerMention: null, external: false });
      expect(r.ownerConfidence).toBe(0.2);
    }
  });

  it("claimed by the unnamed speaker → unresolved, but keeps the speaker", () => {
    const ctx = ctxFor([["S5", "这个我来整理。"]]);
    const r = resolveOwner({ ownerMention: "我", ownerSegmentId: "seg-1", evidence: ["seg-1"] }, ctx);
    expect(r).toMatchObject({ ownerPersonId: null, ownerSpeakerId: "S5", ownerBasis: "unresolved", ownerMention: "我" });
    expect(r.ownerConfidence).toBe(0.5);
    expect(r.reason).toContain("说话人 5");
  });

  it("a 我 cited on someone else's line is looked for in the evidence", () => {
    const ctx = ctxFor([
      ["S4", "试点名单你也要跟他们对一下。"],
      ["S1", "好，名单我来跟孙经理对，这周内。"],
    ]);
    const r = resolveOwner({ ownerMention: "我", ownerSegmentId: "seg-1", evidence: ["seg-1", "seg-2"] }, ctx);
    expect(r).toMatchObject({ ownerPersonId: "p-chen", ownerSpeakerId: "S1", ownerBasis: "self-claimed" });
  });

  it("a refusal is not a claim", () => {
    const ctx = ctxFor([
      ["S1", "小王你有空看一下私有化吗？"],
      ["S2", "我这两周排满了，可能要看看别人。"],
    ]);
    const r = resolveOwner({ ownerMention: "小王", ownerSegmentId: "seg-1", evidence: ["seg-1", "seg-2"] }, ctx);
    expect(r.ownerBasis).toBe("assigned");
    expect(r.ownerConfidence).toBe(0.7);
  });

  it("「好的」 from the owner raises confidence a little", () => {
    const ctx = ctxFor([
      ["S1", "娜娜你周五前把高保真出一下吧。"],
      ["S3", "好的，周五给。"],
    ]);
    const r = resolveOwner({ ownerMention: "娜娜", ownerSegmentId: "seg-1", evidence: ["seg-1", "seg-2"] }, ctx);
    expect(r).toMatchObject({ ownerPersonId: "p-li", ownerBasis: "assigned", ownerSpeakerId: "S1", ownerConfidence: 0.93 });
  });

  describe("name matching", () => {
    const ctx = ctxFor([["S1", "这件事交给你。"]]);
    const owner = (mention: string) => resolveOwner({ ownerMention: mention, ownerSegmentId: "seg-1", evidence: ["seg-1"] }, ctx);

    it.each([
      ["王磊", "p-wang", 0.9],
      ["磊哥", "p-wang", 0.9],
      ["婷婷", "p-zhou", 0.9],
      ["老赵", "p-zhao", 0.9],
      ["「娜娜」", "p-li", 0.9],
      ["建国", "p-zhao", 0.85], // contained in 赵建国
      ["王磊同学", "p-wang", 0.9], // 同学 stripped
      ["李娜老师", "p-li", 0.85], // contains the full name
      ["建国总", "p-zhao", 0.8], // honorific stripped
      ["王总", "p-wang", 0.7], // surname + honorific
      ["娜姐", "p-li", 0.7],
    ])("%s → %s (%s)", (mention, id, confidence) => {
      const r = owner(mention);
      expect(r.ownerPersonId).toBe(id);
      expect(r.ownerBasis).toBe("assigned");
      expect(r.ownerConfidence).toBe(confidence);
    });

    it("only in the directory → directory", () => {
      expect(owner("小刘")).toMatchObject({ ownerPersonId: "p-liu", ownerBasis: "directory", ownerConfidence: 0.85 });
      expect(owner("静姐")).toMatchObject({ ownerPersonId: "p-he", ownerBasis: "directory" });
    });

    it("unknown → unresolved, keeping who said it", () => {
      expect(owner("老钱")).toMatchObject({ ownerPersonId: null, ownerBasis: "unresolved", ownerSpeakerId: "S1", ownerConfidence: 0.3 });
    });

    it("「你」 alone says nothing about who", () => {
      expect(owner("你")).toMatchObject({ ownerPersonId: null, ownerBasis: "unresolved" });
    });

    it("two participants called 小王 → unresolved", () => {
      const wangFang: Person = { id: "p-wang2", name: "王芳", aliases: ["小王"], external: false };
      const r = resolveOwner(
        { ownerMention: "小王", ownerSegmentId: "seg-1", evidence: ["seg-1"] },
        { ...ctx, participants: [...participants, wangFang], directory: [...people, wangFang] },
      );
      expect(r).toMatchObject({ ownerPersonId: null, ownerBasis: "unresolved" });
      expect(r.reason).toContain("王磊");
      expect(r.reason).toContain("王芳");
    });

    it("an exact directory alias beats a participant who only shares the surname", () => {
      const sunLi: Person = { id: "p-sunli", name: "孙丽", aliases: [], external: false };
      const r = resolveOwner(
        { ownerMention: "孙经理", ownerSegmentId: "seg-1", evidence: ["seg-1"] },
        { ...ctx, participants: [...participants, sunLi], directory: [...people, sunLi] },
      );
      expect(r).toMatchObject({ ownerPersonId: "p-sun", ownerBasis: "directory", external: true });
    });

    it("cleans mentions", () => {
      expect(cleanMention(" 小王你 ")).toBe("小王");
      expect(cleanMention("孙经理那边")).toBe("孙经理");
      expect(cleanMention("Kevin")).toBe("kevin");
    });
  });

  it("reproduces the owners of the gold todos", () => {
    const lines: Record<string, string> = {
      "t-101": "seg-0022",
      "t-102": "seg-0038",
      "t-103": "seg-0042",
      "t-104": "seg-0025",
      "t-105": "seg-0025",
      "t-106": "seg-0046",
      "t-107": "seg-0044",
      "t-108": "seg-0049",
    };
    for (const gold of reviewTodos) {
      const r = resolveOwner({ ownerMention: gold.ownerMention, ownerSegmentId: lines[gold.id]!, evidence: gold.evidence }, fixtureCtx);
      expect({ id: gold.id, person: r.ownerPersonId, basis: r.ownerBasis, speaker: r.ownerSpeakerId, external: r.external }).toEqual({
        id: gold.id,
        person: gold.ownerPersonId,
        basis: gold.ownerBasis,
        speaker: gold.ownerSpeakerId,
        external: gold.external,
      });
    }
  });
});


describe("selfMention", () => {
  it("tells a claim from a name or a request", () => {
    expect(["我", "我来", "本人", " 我 "].map(selfMention)).toEqual(["self", "self", "self", "self"]);
    expect(["我们", "咱们"].map(selfMention)).toEqual(["team", "team"]);
    expect(["小王", "你", "王总", "", null].map(selfMention)).toEqual([null, null, null, null, null]);
  });
});
