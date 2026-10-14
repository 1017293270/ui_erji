/**
 * Hand-drawn geometry.
 *
 * Illustrations are described with clean numbers. These helpers turn them into
 * SVG path data that looks drawn with a pen: vertices wander a little, edges
 * bow, corners are soft, closed outlines overshoot or leave a small gap where
 * the pen came back, and fills sit slightly off their outlines like a
 * misregistered print.
 *
 * Every function is a pure function of its input, so a drawing wobbles the same
 * way on the server, in the browser, and on every rebuild.
 */

export type Pt = readonly [number, number];
type Rand = () => number;

/** How the pen behaves. Tuned for drawings about 200 to 900 units wide. */
export const HAND = {
  /** How far vertices wander. */
  jitter: 1.0,
  /** Edge curvature as a share of the edge length, capped by bowMax. */
  bow: 0.014,
  bowMax: 2.6,
  /** Default corner radius. */
  corner: 5,
  /** Edges longer than this get an extra soft bend. */
  segment: 120,
  /** How far fills sit from their outline. */
  fillOffset: [2.4, 2] as Pt,
};

/** A small seeded generator (mulberry32). */
export function rng(seed: number): Rand {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash(...values: number[]): number {
  let h = 2166136261;
  for (const v of values) {
    h = Math.imul(h ^ (Math.round(v * 8) | 0), 16777619);
    h ^= h >>> 15;
  }
  return h >>> 0;
}

const n1 = (n: number) => String(Math.round(n * 10) / 10);
const P = (p: Pt) => `${n1(p[0])} ${n1(p[1])}`;
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Pt, k: number): Pt => [a[0] * k, a[1] * k];
const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const unit = (a: Pt): Pt => {
  const l = Math.hypot(a[0], a[1]) || 1;
  return [a[0] / l, a[1] / l];
};
const perp = (a: Pt): Pt => [-a[1], a[0]];
const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const signed = (r: Rand) => r() * 2 - 1;

export type PolyOptions = {
  /** Close the outline. Default true. */
  closed?: boolean;
  /** Corner radius. */
  r?: number;
  /** Vary the wobble between otherwise identical shapes. */
  seed?: number;
  /** Produce the offset, always-closed outline used for fills. */
  fill?: boolean;
};

/** A polygon or polyline with soft corners and bowed edges. */
export function poly(points: readonly Pt[], o: PolyOptions = {}): string {
  const fill = !!o.fill;
  const closed = fill || (o.closed ?? true);
  const rand = rng((o.seed ?? 0) + hash(...points.flat()) + (fill ? 7 : 0));
  const k = fill ? 1.6 : 1;
  const jitter = HAND.jitter * k;
  const radius = o.r ?? HAND.corner;
  const [ox, oy] = fill ? HAND.fillOffset : [0, 0];

  // 1. Let the vertices wander, and add soft bends along long edges.
  const base: Pt[] = points.map((p) => [
    p[0] + ox + signed(rand) * jitter,
    p[1] + oy + signed(rand) * jitter,
  ]);
  const count = base.length;
  const edgeCount = closed ? count : count - 1;
  const verts: { p: Pt; soft: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    verts.push({ p: base[i]!, soft: false });
    if (i >= edgeCount) continue;
    const a = base[i]!;
    const b = base[(i + 1) % count]!;
    const length = dist(a, b);
    const extra = Math.floor(length / HAND.segment);
    const side = unit(perp(sub(b, a)));
    for (let j = 1; j <= extra; j++) {
      const t = j / (extra + 1);
      const off = signed(rand) * Math.min(1.4, length * 0.01) * k;
      verts.push({
        p: [
          a[0] + (b[0] - a[0]) * t + side[0] * off,
          a[1] + (b[1] - a[1]) * t + side[1] * off,
        ],
        soft: true,
      });
    }
  }

  // 2. Round the corners: the pen arrives at `enter` and leaves from `leave`.
  const n = verts.length;
  const prev = (i: number) => verts[(i + n - 1) % n]!.p;
  const next = (i: number) => verts[(i + 1) % n]!.p;
  const rad = verts.map((v, i) => {
    if (v.soft || radius <= 0) return 0;
    if (!closed && (i === 0 || i === n - 1)) return 0;
    return Math.min(radius, 0.45 * dist(v.p, prev(i)), 0.45 * dist(v.p, next(i)));
  });
  const enter = verts.map((v, i) =>
    rad[i] ? add(v.p, mul(unit(sub(prev(i), v.p)), rad[i]!)) : v.p,
  );
  const leave = verts.map((v, i) =>
    rad[i] ? add(v.p, mul(unit(sub(next(i), v.p)), rad[i]!)) : v.p,
  );

  // 3. Walk the outline: a bowed curve along each edge, a soft turn at each corner.
  const parts: string[] = [`M${P(leave[0]!)}`];
  const edges = closed ? n : n - 1;
  let perimeter = 0;
  let endsInCorner = false;
  for (let i = 0; i < edges; i++) {
    const j = (i + 1) % n;
    const a = leave[i]!;
    const b = enter[j]!;
    const length = dist(a, b);
    perimeter += length;
    const m = mid(a, b);
    const side = unit(perp(sub(b, a)));
    const bow = signed(rand) * Math.min(HAND.bow * k * length, HAND.bowMax * k) * 2;
    parts.push(`Q${P([m[0] + side[0] * bow, m[1] + side[1] * bow])} ${P(b)}`);
    endsInCorner = false;
    if (rad[j] && !(!closed && j === n - 1)) {
      parts.push(`Q${P(verts[j]!.p)} ${P(leave[j]!)}`);
      endsInCorner = true;
    }
  }

  if (!closed) return parts.join("");
  if (fill) return parts.join("") + "Z";

  // A closed outline: most are drawn shut, some overshoot, a few leave a gap.
  const luck = rand();
  if (perimeter < 110 || luck < 0.5) return parts.join("") + "Z";
  if (luck < 0.82 || !endsInCorner) {
    const dir = unit(sub(enter[1 % n]!, leave[0]!));
    return parts.join("") + `L${P(add(leave[0]!, mul(dir, 2.5 + rand() * 3)))}`;
  }
  return parts.slice(0, -1).join("");
}

/** A smooth curve through the points (Catmull-Rom converted to cubic Béziers). */
export function spline(points: readonly Pt[], closed = false): string {
  const n = points.length;
  const at = (i: number): Pt =>
    (closed ? points[(i + n) % n] : points[Math.max(0, Math.min(n - 1, i))])!;
  let d = `M${P(points[0]!)}`;
  const segments = closed ? n : n - 1;
  for (let i = 0; i < segments; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${P(c1)} ${P(c2)} ${P(p2)}`;
  }
  return closed ? d + "Z" : d;
}

/** An ellipse drawn in one pass: it wobbles, and the pen comes back past the start. */
export function oval(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  o: { seed?: number; fill?: boolean } = {},
): string {
  const fill = !!o.fill;
  const rand = rng((o.seed ?? 0) + hash(cx, cy, rx, ry) + (fill ? 11 : 0));
  const perimeter =
    Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
  const k = Math.max(6, Math.min(14, Math.round(perimeter / 44)));
  const start = rand() * Math.PI * 2;
  const tilt = signed(rand) * 0.06;
  const wobble = fill ? 1.7 : 1;
  const [ox, oy] = fill ? HAND.fillOffset : [0, 0];
  const at = (angle: number): Pt => {
    const m = 1 + signed(rand) * 0.016 * wobble;
    const x = Math.cos(angle) * rx * m;
    const y = Math.sin(angle) * ry * m;
    return [
      cx + ox + x * Math.cos(tilt) - y * Math.sin(tilt),
      cy + oy + x * Math.sin(tilt) + y * Math.cos(tilt),
    ];
  };
  const pts: Pt[] = [];
  const steps = fill ? k : k + 1;
  for (let j = 0; j < steps; j++) pts.push(at(start + (Math.PI * 2 * j) / k));
  if (!fill) pts.push(at(start + (Math.PI * 2 * (k + 0.5)) / k));
  return spline(pts, fill);
}

/** A smooth closed shape through the points: clouds, hills, leaves. */
export function blob(
  points: readonly Pt[],
  o: { seed?: number; fill?: boolean } = {},
): string {
  const fill = !!o.fill;
  const rand = rng((o.seed ?? 0) + hash(...points.flat()) + (fill ? 5 : 1));
  const jitter = HAND.jitter * (fill ? 1.6 : 0.8);
  const [ox, oy] = fill ? HAND.fillOffset : [0, 0];
  return spline(
    points.map((p) => [
      p[0] + ox + signed(rand) * jitter,
      p[1] + oy + signed(rand) * jitter,
    ]),
    true,
  );
}

/** An open stroke through the points: smooth, or straight edges with soft bends. */
export function stroke(
  points: readonly Pt[],
  o: { seed?: number; smooth?: boolean; r?: number } = {},
): string {
  if (o.smooth) {
    const rand = rng((o.seed ?? 0) + hash(...points.flat()) + 3);
    const jitter = HAND.jitter * 0.7;
    return spline(
      points.map((p) => [p[0] + signed(rand) * jitter, p[1] + signed(rand) * jitter]),
      false,
    );
  }
  return poly(points, { closed: false, r: o.r, seed: o.seed });
}
