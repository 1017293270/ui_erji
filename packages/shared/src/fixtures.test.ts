import { describe, expect, it } from "vitest";
import { Meeting } from "./meeting";
import { meetings, earlierTodos, people } from "./fixtures";

describe("sample data", () => {
  it("parses against the schema", () => {
    for (const m of meetings) expect(() => Meeting.parse(m)).not.toThrow();
  });

  it("cites only segments that exist", () => {
    const review = meetings.find((m) => m.transcript)!;
    const ids = new Set(review.transcript!.segments.map((s) => s.id));
    const cited = [
      ...review.minutes!.conclusions,
      ...review.minutes!.decisions,
      ...review.minutes!.openQuestions,
      ...review.todos!,
    ].flatMap((p) => p.evidence);
    expect(cited.filter((id) => !ids.has(id))).toEqual([]);
  });

  it("names only people in the roster", () => {
    const known = new Set(people.map((p) => p.id));
    const owners = [...meetings.flatMap((m) => m.todos ?? []), ...earlierTodos].map((t) => t.ownerPersonId);
    expect(owners.filter((id) => id !== null && !known.has(id))).toEqual([]);
  });
});
