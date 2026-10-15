import { describe, expect, it } from "vitest";
import { normalized } from "./voiceprints";

describe("normalized", () => {
  const voice = (x: number) => Array.from({ length: 192 }, (_, i) => (i === 0 ? x : i === 1 ? x / 2 : 0));

  it("keeps huge and tiny values usable", () => {
    for (const x of [1e308, 1e-200, 3]) {
      const v = normalized(voice(x))!;
      expect(v[0]).toBeCloseTo(2 / Math.sqrt(5));
      expect(v[1]).toBeCloseTo(1 / Math.sqrt(5));
    }
  });

  it("refuses what is not an embedding", () => {
    expect(normalized(voice(0))).toBeNull();
    expect(normalized(voice(Number.POSITIVE_INFINITY))).toBeNull();
    expect(normalized([Number.NaN, ...voice(1).slice(1)])).toBeNull();
    expect(normalized([1, 2, 3])).toBeNull();
  });
});
