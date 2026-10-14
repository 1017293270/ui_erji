import { Box, Doodle, Line, Oval, Part, Poly } from "../doodle/shapes";
import { css, pivot } from "./claude";

/**
 * EchoMind's own drawings, in the same pen as claude.tsx: ink outlines, white
 * and warm-gray fills, one clay accent on the thing the drawing is about.
 */

/** The app mark: a clay speech bubble holding a couple of lines of notes. */
export function EchoMark({ className }: { className?: string }) {
  return (
    <Doodle viewBox="0 0 48 48" sw={3.4} draw={false} className={"echo-mark " + (className ?? "")}>
      <Part transform="rotate(-7 24 24)">
        <Poly pts={[[7, 9], [41, 9], [41, 33], [22, 33], [12, 42], [14, 33], [7, 33]]} r={5} fill="accent" seed={2} />
        <Line pts={[[14, 18], [34, 18]]} sw={3} seed={3} />
        <Line pts={[[14, 25], [27, 25]]} sw={3} seed={4} />
      </Part>
    </Doodle>
  );
}

/** Headphones, sound leaving them, and the note it turns into: the home page. 260 x 180. */
export function ListenNote({ className }: { className?: string }) {
  return (
    <Doodle viewBox="0 0 260 180" sw={4.5} className={className}>
      <Part i={0}>
        <Line pts={[[42, 104], [40, 66], [64, 34], [90, 26], [116, 34], [140, 66], [138, 104]]} smooth sw={15} seed={1} />
        <Line pts={[[42, 104], [40, 66], [64, 34], [90, 26], [116, 34], [140, 66], [138, 104]]} smooth sw={6} pen="mid" seed={1} still />
      </Part>
      <Part i={1}>
        <Box x={52} y={104} w={12} h={46} r={4} fill="soft" seed={2} />
        <Box x={22} y={96} w={34} h={62} r={14} fill="paper" seed={3} />
        <Box x={116} y={104} w={12} h={46} r={4} fill="soft" seed={4} />
        <Box x={124} y={96} w={34} h={62} r={14} fill="paper" seed={5} />
      </Part>
      <Part i={2} className="dd-pulse" style={css({ "--dur": "1.8s", "--to": "1.1" })}>
        <Line pts={[[170, 108], [177, 122], [170, 136]]} smooth sw={4} seed={6} />
        <Line pts={[[182, 98], [192, 122], [182, 146]]} smooth sw={4} seed={7} />
      </Part>
      <Part i={3} className="dd-float" style={css({ "--amp": "4px", "--dur": "2.8s" })}>
        <Part transform="rotate(8 222 52)">
          <Box x={192} y={30} w={60} h={46} r={6} fill="accent" seed={8} />
          <Line pts={[[202, 46], [240, 46]]} sw={3.4} seed={9} />
          <Line pts={[[202, 58], [226, 58]]} sw={3.4} seed={10} />
        </Part>
      </Part>
    </Doodle>
  );
}

/** A clay microphone on its stand; `live` adds the sound it is picking up. 140 x 150. */
export function MicDoodle({ className, live = false }: { className?: string; live?: boolean }) {
  return (
    <Doodle viewBox="0 0 140 150" sw={4.5} className={className}>
      <Part i={0}>
        <Line pts={[[34, 54], [38, 80], [70, 96], [102, 80], [106, 54]]} smooth sw={5} seed={1} />
        <Line pts={[[70, 96], [70, 124]]} sw={5} seed={2} />
        <Box x={44} y={122} w={52} h={14} r={6} fill="mid" seed={3} />
      </Part>
      <Part i={1}>
        <Box x={50} y={10} w={40} h={72} r={20} fill="accent" seed={4} />
        <Line pts={[[59, 32], [81, 32]]} sw={3.4} seed={5} />
        <Line pts={[[59, 44], [81, 44]]} sw={3.4} seed={6} />
        <Line pts={[[59, 56], [81, 56]]} sw={3.4} seed={7} />
      </Part>
      {live ? (
        <Part i={2} className="dd-pulse" style={css({ "--dur": "1.2s", "--to": "1.12" })}>
          <Line pts={[[28, 18], [18, 36], [28, 54]]} smooth sw={4} seed={8} />
          <Line pts={[[112, 18], [122, 36], [112, 54]]} smooth sw={4} seed={9} />
        </Part>
      ) : null}
    </Doodle>
  );
}

/** A laptop with someone talking on screen: the computer's own sound. 150 x 110. */
export function LaptopVoice({ className }: { className?: string }) {
  return (
    <Doodle viewBox="0 0 150 110" sw={4.5} className={className}>
      <Part i={0}>
        <Box x={22} y={14} w={90} h={64} r={7} fill="paper" seed={1} />
        <Poly pts={[[10, 80], [124, 80], [116, 98], [18, 98]]} r={4} fill="mid" seed={2} />
      </Part>
      <Part i={1} className="dd-float" style={css({ "--amp": "2px", "--dur": "2.4s" })}>
        <Poly pts={[[42, 28], [92, 28], [92, 56], [60, 56], [50, 66], [52, 56], [42, 56]]} r={5} fill="accent" seed={3} />
        <Line pts={[[52, 40], [82, 40]]} sw={3.2} seed={4} />
      </Part>
      <Part i={2} className="dd-pulse" style={css({ "--dur": "1.6s" })}>
        <Line pts={[[124, 26], [131, 42], [124, 58]]} smooth sw={4} seed={5} />
        <Line pts={[[135, 18], [144, 42], [135, 66]]} smooth sw={4} seed={6} />
      </Part>
    </Doodle>
  );
}

const DAYS: [x: number, y: number][] = [
  [40, 80], [84, 80], [128, 80],
  [40, 124], [84, 124], [128, 124],
];

/** A week on a calendar card, days ticking themselves off: the team board. 220 x 190. */
export function WeekCalendar({ className }: { className?: string }) {
  const ticked = [0, 1, 3];
  return (
    <Doodle viewBox="0 0 220 190" sw={4.5} className={className}>
      <Part i={0}>
        <Box x={24} y={30} w={172} h={146} r={14} fill="paper" seed={1} />
        <Box x={24} y={30} w={172} h={34} r={12} fill="mid" seed={2} />
      </Part>
      <Part i={1}>
        <Line pts={[[70, 16], [70, 44]]} sw={8} seed={3} />
        <Line pts={[[150, 16], [150, 44]]} sw={8} seed={4} />
      </Part>
      <Part i={2}>
        {DAYS.map(([x, y], k) => (
          <Box key={k} x={x} y={y} w={36} h={36} r={6} fill={k === 4 ? "soft" : "paper"} sw={3.6} seed={5 + k} />
        ))}
      </Part>
      {ticked.map((k, n) => {
        const [x, y] = DAYS[k]!;
        return (
          <path
            key={k}
            className="ln p-accent dd-tick"
            pathLength={1}
            d={`M${x + 8} ${y + 18}L${x + 15} ${y + 26}L${x + 29} ${y + 8}`}
            style={css({ strokeWidth: 5, "--delay": `${0.6 + n * 0.6}s`, "--dur": "6s" })}
          />
        );
      })}
    </Doodle>
  );
}

const BARS = [6, 12, 18, 9, 22, 14, 7, 16, 24, 11, 17, 8, 13, 6];

/** A colleague's card with their voiceprint and the clay seal of their consent: people. 230 x 170. */
export function VoiceCard({ className }: { className?: string }) {
  return (
    <Doodle viewBox="0 0 230 170" sw={4.5} className={className}>
      <Part i={0}>
        <Box x={18} y={40} w={168} h={110} r={14} fill="paper" seed={1} />
        <Oval cx={56} cy={80} rx={18} fill="soft" seed={2} />
        <Line pts={[[88, 70], [152, 70]]} sw={4} pen="faint" seed={3} />
        <Line pts={[[88, 86], [132, 86]]} sw={4} pen="faint" seed={4} />
      </Part>
      <Part i={1}>
        {BARS.map((h, k) => (
          <Line key={k} pts={[[42 + k * 9, 124 - h / 2], [42 + k * 9, 124 + h / 2]]} sw={4} seed={5 + k} />
        ))}
      </Part>
      <Part i={2} className="dd-sway" style={{ ...css({ "--amp": "6deg", "--dur": "2.2s" }), ...pivot(184, 46) }}>
        <Oval cx={184} cy={46} rx={24} fill="accent" seed={20} />
        <Line pts={[[173, 46], [181, 55], [196, 37]]} sw={4.5} seed={21} />
      </Part>
    </Doodle>
  );
}
