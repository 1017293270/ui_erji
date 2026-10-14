import type { Segment } from "@echomind/shared";

/**
 * Looks up segment ids the model cited. Accepts the small slips models make
 * (seg-12, SEG-0012, 0012, 「seg-0012」) when they point at exactly one real
 * segment; anything else is reported as not existing.
 */
export class SegmentIndex {
  readonly segments: readonly Segment[];
  private readonly position = new Map<string, number>();
  private readonly byLower = new Map<string, string>();
  private readonly byNumber = new Map<number, string | null>();

  constructor(segments: readonly Segment[]) {
    this.segments = segments;
    segments.forEach((s, i) => {
      this.position.set(s.id, i);
      this.byLower.set(s.id.toLowerCase(), s.id);
      const n = trailingNumber(s.id);
      if (n !== null) this.byNumber.set(n, this.byNumber.has(n) ? null : s.id); // null: not unique
    });
  }

  get size(): number {
    return this.segments.length;
  }

  has(id: string): boolean {
    return this.position.has(id);
  }

  indexOf(id: string): number {
    return this.position.get(id) ?? -1;
  }

  at(i: number): Segment {
    return this.segments[i]!;
  }

  /** The real id the model meant, or null. */
  resolve(raw: unknown): string | null {
    if (typeof raw === "number") return this.byNumber.get(raw) ?? null;
    if (typeof raw !== "string") return null;
    const s = raw.trim().replace(/^[「『\["'(（]+|[」』\]"')）]+$/g, "");
    if (this.position.has(s)) return s;
    const lower = this.byLower.get(s.toLowerCase());
    if (lower) return lower;
    if (/^(seg)?[-_ ]?\d+$/i.test(s)) {
      const n = trailingNumber(s);
      if (n !== null) return this.byNumber.get(n) ?? null;
    }
    return null;
  }

  /**
   * A cited evidence list → real ids in transcript order, without repeats.
   * Unknown ids are dropped and reported through `unknown`.
   * Ranges like "seg-0019~seg-0021" are expanded (up to 8 segments).
   */
  evidence(raw: unknown, unknown: (id: string) => void): string[] {
    const items: unknown[] = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
    const ids = new Set<string>();
    for (const item of items) {
      for (const piece of typeof item === "string" ? item.split(/[,，、;；\s]+/).filter(Boolean) : [item]) {
        const range = typeof piece === "string" ? /^(.+?)(?:~|～|—|至|到|\.\.)(.+)$/.exec(piece) : null;
        if (range) {
          const a = this.resolve(range[1]);
          const b = this.resolve(range[2]);
          if (a && b) {
            const [from, to] = [this.indexOf(a), this.indexOf(b)].sort((x, y) => x - y) as [number, number];
            if (to - from <= 8) {
              for (let i = from; i <= to; i++) ids.add(this.at(i).id);
              continue;
            }
            ids.add(a).add(b);
            continue;
          }
        }
        const id = this.resolve(piece);
        if (id) ids.add(id);
        else unknown(String(piece));
      }
    }
    return [...ids].sort((a, b) => this.indexOf(a) - this.indexOf(b));
  }
}

function trailingNumber(id: string): number | null {
  const m = /(\d+)\s*$/.exec(id);
  return m ? Number(m[1]) : null;
}
