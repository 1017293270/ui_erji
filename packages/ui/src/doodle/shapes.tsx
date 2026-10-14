import type { CSSProperties, ReactNode } from "react";
import { cn } from "./cn";
import { blob, oval, poly, stroke, type Pt } from "./sketch";

export type { Pt };

/** Fill colors: white paper, two grays, solid ink, the accent, and a pale accent. */
export type Tone = "paper" | "soft" | "mid" | "ink" | "accent" | "tint" | "none";
/** Pen colors for outlines. */
export type Pen = "ink" | "accent" | "faint" | "mid" | "none";

type Common = {
  fill?: Tone;
  pen?: Pen;
  /** Stroke width for this shape, in drawing units. */
  sw?: number;
  /** Draw-on order. Higher numbers draw later; shapes in a group share it. */
  i?: number;
  /** Vary the wobble between otherwise identical shapes. */
  seed?: number;
  /** A dotted guide line instead of a solid stroke. */
  dash?: boolean;
  /** No entrance of its own: something else (CSS) animates this stroke. */
  still?: boolean;
  /** Wraps the shape in a group with this class (for idle motion). */
  className?: string;
  /** Extra style for the wrapping group (custom properties for motion). */
  style?: CSSProperties;
};

function Drawn({
  fillD,
  lineD,
  fill = "paper",
  pen = "ink",
  sw,
  i,
  dash,
  still,
  className,
  style,
}: Common & { fillD?: string; lineD?: string }) {
  const drawn = !dash && !still;
  const order = i === undefined ? undefined : ({ "--i": i } as CSSProperties);
  const lineStyle = sw ? ({ ...order, strokeWidth: sw } as CSSProperties) : order;
  const parts = (
    <>
      {fill !== "none" && fillD ? (
        <path className={cn("fl", `f-${fill}`)} d={fillD} style={order} />
      ) : null}
      {pen !== "none" && lineD ? (
        <path
          className={cn("ln", `p-${pen}`, dash ? "ln-dash" : still ? "ln-still" : "ln-draw")}
          d={lineD}
          pathLength={drawn ? 1 : undefined}
          style={lineStyle}
        />
      ) : null}
    </>
  );
  return className || style ? (
    <g className={className} style={style}>
      {parts}
    </g>
  ) : (
    parts
  );
}

/** A rectangle with soft corners. */
export function Box({
  x,
  y,
  w,
  h,
  r,
  ...c
}: { x: number; y: number; w: number; h: number; r?: number } & Common) {
  const pts: Pt[] = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
  return (
    <Drawn
      {...c}
      fillD={poly(pts, { r, fill: true, seed: c.seed })}
      lineD={poly(pts, { r, seed: c.seed })}
    />
  );
}

/** A polygon (closed) or a polyline (open) with soft corners. */
export function Poly({
  pts,
  r,
  closed = true,
  ...c
}: { pts: readonly Pt[]; r?: number; closed?: boolean } & Common) {
  return (
    <Drawn
      {...c}
      fillD={closed ? poly(pts, { r, fill: true, seed: c.seed }) : undefined}
      lineD={poly(pts, { r, closed, seed: c.seed })}
    />
  );
}

/** An ellipse (a circle when ry is left out). */
export function Oval({
  cx,
  cy,
  rx,
  ry = rx,
  ...c
}: { cx: number; cy: number; rx: number; ry?: number } & Common) {
  return (
    <Drawn
      {...c}
      fillD={oval(cx, cy, rx, ry, { fill: true, seed: c.seed })}
      lineD={oval(cx, cy, rx, ry, { seed: c.seed })}
    />
  );
}

/** A smooth closed shape through the points: clouds, hills, leaves. */
export function Blob({ pts, ...c }: { pts: readonly Pt[] } & Common) {
  return (
    <Drawn
      {...c}
      fillD={blob(pts, { fill: true, seed: c.seed })}
      lineD={blob(pts, { seed: c.seed })}
    />
  );
}

/** An open stroke with no fill: lines, handles, strings, tick marks. */
export function Line({
  pts,
  smooth = false,
  r,
  ...c
}: { pts: readonly Pt[]; smooth?: boolean; r?: number } & Common) {
  return (
    <Drawn {...c} fill="none" lineD={stroke(pts, { smooth, r, seed: c.seed })} />
  );
}

/** A perfectly straight line between two points: taut strings, rulers, guides. */
export function Rule({
  from,
  to,
  ...c
}: { from: Pt; to: Pt } & Common) {
  return (
    <Drawn
      {...c}
      fill="none"
      lineD={`M${from[0]} ${from[1]}L${to[0]} ${to[1]}`}
    />
  );
}

/** Path data used as is (for curves and arrows drawn by hand). */
export function Raw({ d, fillD, ...c }: { d: string; fillD?: string } & Common) {
  return <Drawn {...c} fill={fillD ? c.fill : "none"} fillD={fillD} lineD={d} />;
}

/** A small solid dot: rivets, eyes, chalk dust. */
export function Dot({
  cx,
  cy,
  r = 3,
  tone = "ink",
  i,
  className,
  style,
}: {
  cx: number;
  cy: number;
  r?: number;
  tone?: Tone;
  i?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <circle
      cx={cx}
      cy={cy}
      r={r}
      className={cn("fl", `f-${tone}`, className)}
      style={i === undefined ? style : ({ "--i": i, ...style } as CSSProperties)}
    />
  );
}

/** Groups parts so they share a draw-on order, an idle loop, or a transform. */
export function Part({
  i,
  className,
  style,
  transform,
  children,
}: {
  i?: number;
  className?: string;
  style?: CSSProperties;
  transform?: string;
  children: ReactNode;
}) {
  const merged =
    i === undefined ? style : ({ "--i": i, ...style } as CSSProperties);
  return (
    <g className={className} style={merged} transform={transform}>
      {children}
    </g>
  );
}

/**
 * The drawing's canvas. Drawings are decorative by default; pass a label to
 * describe one that carries meaning.
 */
export function Doodle({
  viewBox,
  sw = 3,
  label,
  className,
  style,
  draw = true,
  children,
}: {
  viewBox: string;
  /** Default stroke width in drawing units. */
  sw?: number;
  label?: string;
  className?: string;
  style?: CSSProperties;
  /** Draw the strokes on when the drawing first scrolls into view. */
  draw?: boolean;
  children: ReactNode;
}) {
  const [, , width, height] = viewBox.split(" ").map(Number);
  return (
    <svg
      viewBox={viewBox}
      className={cn("dd", className)}
      data-draw={draw ? "" : undefined}
      style={{ "--dd-w": sw, aspectRatio: `${width} / ${height}`, ...style } as CSSProperties}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {children}
    </svg>
  );
}
