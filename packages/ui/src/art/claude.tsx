import type { CSSProperties } from "react";
import { Box, Doodle, Dot, Line, Oval, Part, Poly, Raw, type Pt } from "../doodle/shapes";
import { stroke } from "../doodle/sketch";

/**
 * The Claude-variant drawings from the hand-drawn-illustration kit: thick ink,
 * white and warm-gray fills and at most one clay accent, drawn small and
 * straight onto the page (no colored blocks behind them). Coordinates are clean
 * numbers in each drawing's own viewBox; the engine adds the wobble.
 * EchoMind's own drawings live in echomind.tsx and reuse Hand and reach.
 */

export const css = (v: Record<string, string | number>) => v as CSSProperties;
export const pivot = (x: number, y: number) => ({ transformBox: "view-box", transformOrigin: `${x}px ${y}px` }) as CSSProperties;

/** An open hand pointing down, palm toward us, thumb on the right. About 104 x 140 at s = 1. */
export const HAND: Pt[] = [
  [22, 0], [20, 56], [14, 90], [14, 124], [29, 126], [30, 100], [31, 136], [47, 137], [48, 102],
  [49, 138], [64, 136], [65, 100], [66, 128], [80, 125], [81, 96], [90, 114], [103, 106], [99, 74], [80, 52], [80, 0],
];
export function Hand({ s = 1, seed = 0, i }: { s?: number; seed?: number; i?: number }) {
  return <Poly i={i} pts={HAND.map(([x, y]) => [x * s, y * s] as const)} r={7 * s} fill="paper" seed={seed} />;
}
/** Places a hand so its middle fingertip lands on (x, y), turned by `angle` (0 points down). */
export const reach = (x: number, y: number, angle: number, s = 1) => `translate(${x} ${y}) rotate(${angle}) translate(${-48 * s} ${-128 * s})`;

/** Two hands passing a slip across: the login page. 320 x 260. */
export function Handoff({ className, label }: { className?: string; label?: string }) {
  return (
    <Doodle viewBox="0 0 320 260" sw={5} className={className} label={label}>
      <Part i={0} className="dd-sway" style={css({ "--amp": "2.5deg", "--dur": "3.4s" })}>
        <Part transform="rotate(-10 160 130)">
          <Box x={120} y={98} w={80} h={64} r={8} fill="mid" seed={1} />
          <Line pts={[[148, 124], [180, 124]]} sw={4} pen="faint" seed={2} />
          <Line pts={[[148, 137], [170, 137]]} sw={4} pen="faint" seed={3} />
        </Part>
      </Part>
      <Part i={1} className="dd-reach" style={css({ "--dx": "4px", "--dy": "6px", "--dur": "3.4s" })}>
        <g transform={reach(132, 98, -34)}><Hand seed={4} /></g>
      </Part>
      <Part i={2} className="dd-reach" style={css({ "--dx": "-4px", "--dy": "-6px", "--dur": "3.4s" })}>
        <g transform={reach(188, 162, 146)}><Hand seed={9} /></g>
      </Part>
      <Part i={3} className="dd-pulse" style={css({ "--dur": "1.7s", "--to": "1.08" })}>
        <Line pts={[[222, 92], [236, 80]]} sw={4.5} seed={5} />
        <Line pts={[[228, 108], [244, 104]]} sw={4.5} seed={6} />
        <Line pts={[[212, 82], [216, 66]]} sw={4.5} seed={7} />
      </Part>
    </Doodle>
  );
}

/** A hand lifting the one good slip off a stack: the sidebar. 200 x 130. */
export function PluckSlip({ className }: { className?: string }) {
  return (
    <Doodle viewBox="0 0 200 130" sw={4} className={className}>
      <Part i={0}>
        <Box x={52} y={104} w={96} h={20} r={5} fill="soft" seed={1} />
        <Box x={46} y={92} w={96} h={20} r={5} fill="paper" seed={2} />
        <Line pts={[[58, 102], [96, 102]]} sw={3} pen="faint" seed={3} />
      </Part>
      <Part i={1} className="dd-float" style={css({ "--amp": "4px", "--dur": "2.6s" })}>
        <Part transform="rotate(-7 100 72)">
          <Box x={70} y={56} w={60} h={34} r={5} fill="accent" seed={4} />
          <Line pts={[[80, 70], [116, 70]]} sw={3} seed={5} />
          <Line pts={[[80, 79], [104, 79]]} sw={3} seed={6} />
        </Part>
        <g transform={reach(98, 66, 4, 0.5)}><Hand s={0.5} seed={7} /></g>
      </Part>
      <Part i={2} className="dd-pulse" style={css({ "--dur": "2.6s" })}>
        <Line pts={[[146, 50], [156, 42]]} sw={3.4} seed={8} />
        <Line pts={[[150, 62], [162, 60]]} sw={3.4} seed={9} />
      </Part>
    </Doodle>
  );
}

/** A hand waving goodbye: the sign-out page. 200 x 170. */
export function Wave({ className }: { className?: string }) {
  return (
    <Doodle viewBox="0 0 200 170" sw={5} className={className}>
      <Part i={0} className="dd-sway" style={{ ...css({ "--amp": "9deg", "--dur": "0.9s" }), ...pivot(100, 168) }}>
        <g transform={reach(100, 22, 180)}><Hand seed={3} /></g>
      </Part>
      <Part i={1} className="dd-pulse" style={css({ "--dur": "1.8s" })}>
        <Line pts={[[26, 46], [14, 68], [22, 90]]} smooth sw={4} seed={4} />
        <Line pts={[[174, 46], [186, 68], [178, 90]]} smooth sw={4} seed={5} />
      </Part>
    </Doodle>
  );
}

/** An open toolbox whose tools bob: the empty board (the Skill fetches the work). 240 x 190. */
export function Toolbox({ className }: { className?: string }) {
  return (
    <Doodle viewBox="0 0 240 190" sw={4} className={className}>
      <Part i={0}>
        <Line pts={[[90, 98], [90, 58], [150, 58], [150, 98]]} r={18} sw={17} seed={3} />
        <Line pts={[[90, 98], [90, 58], [150, 58], [150, 98]]} r={18} sw={8} pen="mid" seed={3} still />
      </Part>
      <Part i={1}>
        <Part className="dd-float" style={css({ "--dur": "2.8s", "--amp": "3px" })}>
          <Part transform="rotate(-12 62 100)">
            <Box x={50} y={42} w={22} h={60} r={10} fill="accent" seed={1} />
            <Line pts={[[57, 52], [57, 80]]} sw={2.6} seed={4} />
            <Line pts={[[65, 52], [65, 80]]} sw={2.6} seed={5} />
          </Part>
        </Part>
        <Part className="dd-float" style={css({ "--dur": "3.3s", "--amp": "3px", "--delay": "-1.2s" })}>
          <Box x={100} y={40} w={26} h={70} r={4} fill="paper" seed={2} />
          <Oval cx={113} cy={54} rx={6} fill="soft" sw={3} seed={2} />
          <Line pts={[[100, 70], [108, 70]]} sw={2.6} seed={6} />
          <Line pts={[[100, 82], [111, 82]]} sw={2.6} seed={7} />
          <Line pts={[[100, 94], [108, 94]]} sw={2.6} seed={8} />
        </Part>
        <Part className="dd-float" style={css({ "--dur": "3s", "--amp": "3px", "--delay": "-0.6s" })}>
          <Part transform="rotate(14 172 104)">
            <Box x={164} y={52} w={15} h={56} r={5} fill="soft" seed={3} />
            <Box x={150} y={34} w={44} h={22} r={6} fill="mid" seed={5} />
          </Part>
        </Part>
      </Part>
      <Part i={2}>
        <Box x={22} y={104} w={196} h={78} r={11} fill="paper" seed={4} />
        <Box x={14} y={92} w={212} h={22} r={9} fill="soft" seed={5} />
      </Part>
      <Part i={3}>
        <Box x={62} y={100} w={20} h={28} r={5} fill="mid" seed={6} />
        <Box x={158} y={100} w={20} h={28} r={5} fill="mid" seed={7} />
        <Dot cx={72} cy={113} r={2.6} />
        <Dot cx={168} cy={113} r={2.6} />
      </Part>
    </Doodle>
  );
}

const TRAIL_LEFT = stroke([[10, 64], [42, 44], [76, 52], [104, 74], [122, 96]], { smooth: true });
const TRAIL_RIGHT = stroke([[292, 52], [262, 40], [226, 50], [196, 74], [182, 94]], { smooth: true });

/** Mail and pages flying into one tray: the sources page. 300 x 190. */
export function InboxTray({ className }: { className?: string }) {
  return (
    <Doodle viewBox="0 0 300 190" sw={4} className={className}>
      <Part i={0}>
        <Part className="dd-flow"><Raw d={TRAIL_LEFT} pen="faint" dash sw={4} /></Part>
        <Part className="dd-flow"><Raw d={TRAIL_RIGHT} pen="faint" dash sw={4} /></Part>
      </Part>
      <Part i={1}>
        <Part transform="rotate(-8 132 106)"><Box x={104} y={84} w={60} h={48} r={5} fill="paper" seed={1} /></Part>
        <Part transform="rotate(7 168 100)">
          <Box x={140} y={76} w={60} h={52} r={5} fill="soft" seed={2} />
          <Line pts={[[150, 90], [184, 90]]} sw={3} pen="faint" seed={3} />
        </Part>
      </Part>
      <Part i={2}>
        <Poly pts={[[82, 112], [218, 112], [210, 170], [90, 170]]} r={9} fill="mid" seed={4} />
        <Line pts={[[96, 126], [124, 126], [134, 140], [166, 140], [176, 126], [204, 126]]} r={6} sw={4} seed={5} />
      </Part>
      <Part i={3} className="dd-float" style={css({ "--amp": "5px", "--dur": "2.4s" })}>
        <Part transform="rotate(-14 60 40)">
          <Box x={34} y={22} w={54} h={38} r={5} fill="paper" seed={6} />
          <Line pts={[[36, 26], [61, 45], [86, 26]]} r={3} sw={3.4} seed={7} />
          <Oval cx={61} cy={45} rx={5} fill="accent" sw={3} seed={8} />
        </Part>
      </Part>
      <Part i={3} className="dd-float" style={css({ "--amp": "4px", "--dur": "2.9s", "--delay": "-1s" })}>
        <Poly pts={[[268, 22], [214, 36], [230, 46]]} r={2} fill="paper" seed={9} />
        <Poly pts={[[268, 22], [230, 46], [224, 66]]} r={2} fill="soft" seed={10} />
        <Line pts={[[268, 22], [230, 46]]} sw={3.4} seed={11} />
      </Part>
    </Doodle>
  );
}

/** A clipboard whose rows tick themselves, and the pencil that did it: import history. 240 x 210. */
export function Clipboard({ className }: { className?: string }) {
  const rows = [74, 108, 142];
  return (
    <Doodle viewBox="0 0 240 210" sw={4} className={className}>
      <Part i={0}>
        <Box x={58} y={26} w={124} h={170} r={12} fill="mid" seed={1} />
        <Box x={70} y={44} w={100} h={140} r={6} fill="paper" seed={2} />
      </Part>
      <Part i={1}>
        <Box x={94} y={16} w={52} h={24} r={8} fill="soft" seed={3} />
        <Oval cx={120} cy={16} rx={7} fill="paper" sw={3.4} seed={4} />
      </Part>
      <Part i={2}>
        {rows.map((y, k) => (
          <g key={y}>
            <Box x={82} y={y} w={18} h={18} r={4} fill="paper" sw={3.4} seed={5 + k} />
            <Line pts={[[110, y + 9], [154 - k * 8, y + 9]]} sw={3.4} seed={8 + k} />
          </g>
        ))}
      </Part>
      {rows.map((y, k) => (
        <path key={y} className="ln p-accent dd-tick" pathLength={1} d={stroke([[84, y + 8], [91, y + 16], [104, y - 4]], { seed: 11 + k })}
          style={css({ strokeWidth: 5, "--delay": `${0.7 + k * 0.6}s`, "--dur": "6s" })} />
      ))}
      <Part i={3} className="dd-sway" style={{ ...css({ "--amp": "5deg", "--dur": "1.5s" }), ...pivot(186, 160) }}>
        <Poly pts={[[178, 168], [216, 124], [228, 134], [190, 178]]} r={3} fill="soft" seed={14} />
        <Poly pts={[[178, 168], [190, 178], [172, 188]]} r={2} fill="paper" seed={15} />
        <Dot cx={175} cy={185} r={2.6} />
      </Part>
    </Doodle>
  );
}

/** Blocks stacked, one more on its way: can we deliver it. 144 x 144. */
function Blocks() {
  return (
    <>
      <Part i={0}>
        <Box x={20} y={86} w={50} h={40} r={6} fill="soft" seed={1} />
        <Box x={74} y={86} w={50} h={40} r={6} fill="mid" seed={2} />
      </Part>
      <Part i={1}><Box x={47} y={44} w={50} h={40} r={6} fill="paper" seed={3} /></Part>
      <Part i={2} className="dd-float" style={css({ "--amp": "4px", "--dur": "2.2s" })}>
        <Box x={59} y={6} w={28} h={28} r={5} fill="accent" seed={4} />
      </Part>
    </>
  );
}
/** A price tag on its string: is it worth it. */
function Tag() {
  return (
    <Part className="dd-sway dd-wiggle" style={{ ...css({ "--amp": "6deg", "--dur": "2.4s" }), ...pivot(40, 24) }}>
      <Line pts={[[40, 24], [52, 40], [58, 56]]} smooth sw={4} seed={1} i={0} />
      <Poly i={1} pts={[[44, 52], [92, 44], [120, 74], [100, 118], [56, 112]]} r={7} fill="accent" seed={2} />
      <Oval i={1} cx={60} cy={60} rx={7} fill="paper" sw={4} seed={3} />
      <Line i={2} pts={[[70, 84], [100, 80]]} sw={4} seed={4} />
      <Line i={2} pts={[[72, 98], [92, 95]]} sw={4} seed={5} />
    </Part>
  );
}
/** A page under a magnifier: know the client. */
function Lens() {
  return (
    <>
      <Part i={0}><Box x={22} y={16} w={72} h={96} r={9} fill="paper" seed={1} /></Part>
      <Part i={1}>
        <Line pts={[[38, 42], [78, 42]]} sw={4} pen="faint" seed={2} />
        <Line pts={[[38, 58], [72, 58]]} sw={4} pen="faint" seed={3} />
        <Line pts={[[38, 74], [62, 74]]} sw={4} pen="faint" seed={4} />
      </Part>
      <Part i={2} className="dd-drift dd-wiggle" style={css({ "--amp": "5px", "--dur": "2.8s" })}>
        <Line pts={[[103, 100], [127, 126]]} sw={11} seed={5} />
        <Oval cx={88} cy={84} rx={26} fill="tint" seed={6} />
        <Line pts={[[75, 76], [82, 68]]} sw={4} pen="faint" smooth seed={7} />
      </Part>
    </>
  );
}
/** A note pinned up: keep the evidence. */
function Pinned() {
  return (
    <>
      <Part i={0} className="dd-sway" style={{ ...css({ "--amp": "2.5deg", "--dur": "2.6s" }), ...pivot(72, 28) }}>
        <Part transform="rotate(4 72 72)">
          <Box x={30} y={26} w={84} h={94} r={7} fill="paper" seed={1} />
          <Line pts={[[44, 60], [98, 60]]} sw={4} pen="faint" seed={2} />
          <Line pts={[[44, 76], [92, 76]]} sw={4} pen="faint" seed={3} />
          <Line pts={[[44, 92], [80, 92]]} sw={4} pen="faint" seed={4} />
        </Part>
      </Part>
      <Part i={1} className="dd-wiggle">
        <Line pts={[[72, 30], [74, 46]]} sw={4} seed={5} />
        <Oval cx={71} cy={26} rx={10} fill="accent" seed={6} />
      </Part>
    </>
  );
}
const RULE_ICONS = [Blocks, Tag, Lens, Pinned];
export function RuleIcon({ index, className }: { index: number; className?: string }) {
  const Icon = RULE_ICONS[index] ?? Blocks;
  return <Doodle viewBox="0 0 144 144" sw={5} className={className}><Icon /></Doodle>;
}
/** The magnifier on its own, for "nothing matched" and errors. */
export function SearchArt({ className }: { className?: string }) {
  return <Doodle viewBox="0 0 144 144" sw={5} className={className}><Lens /></Doodle>;
}

