#!/usr/bin/env bash
# Builds a synthetic recording folder in the echomind-capture format, from macOS `say`.
#
#   scripts/make-fixture.sh <out_dir> [--repeat N] [--echo] [--voices MIC,A,B]
#
# - mic track: one voice (the local user); system track: two other voices.
# - 60 s segments with one pause (no files during it), like a real `record` run.
# - --repeat N plays the meeting N times in a row (for long-meeting / speed tests).
# - --echo also leaks the system track into the mic, as when the user has no headphones.
# - expected.json lists every utterance with its track, voice, start/end (ms) and text,
#   for scripts/check-transcript.py.
#
# Never point this at the real recordings folder; it only writes into <out_dir>.
set -euo pipefail

out=${1:?"用法：make-fixture.sh <输出文件夹> [--repeat N] [--echo] [--voices MIC,A,B]"}
shift
repeat=1
echo_leak=0
voices="Tingting,Eddy (Chinese (China mainland)),Meijia"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repeat) repeat=$2; shift 2 ;;
    --echo) echo_leak=1; shift ;;
    --voices) voices=$2; shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done
IFS=, read -r voice_mic voice_a voice_b <<<"$voices"

if [[ -e "$out" && -n "$(ls -A "$out" 2>/dev/null)" ]]; then
  echo "输出文件夹不是空的：$out" >&2
  exit 1
fi
mkdir -p "$out"
clips=$(mktemp -d)
trap 'rm -rf "$clips"' EXIT

# who<TAB>text. "me" is the mic track; a and b are the two remote voices.
# A line with only "--pause" marks where the recording is paused for 10 s.
script=$(cat <<'EOF'
a	大家好，我们开始今天的周会吧。先同步一下新版本的进度。
me	好的，我先说一下客户端这边。iOS 版本上周已经提交审核了，安卓版本还在做最后的测试。
b	服务端这边，新的 API 接口已经全部上线，文档我今天下午发到群里。
a	这次发布最大的风险是什么？
me	主要是支付模块，第三方的 SDK 升级以后有一些兼容性问题，我们还在排查。
b	如果需要的话，我可以安排一个后端同学帮忙一起看日志。
a	好，那这件事就交给你们两个跟进，周五之前给我一个结论。
me	没问题，周五之前我把排查结果整理成文档。
b	另外，市场部希望我们在发布会之前准备一个演示环境。
a	演示环境用测试服务器就可以，数据要提前脱敏。
me	我建议演示的时候不要用真实的用户数据，我们可以造一批假数据。
b	同意，我来写一个脚本生成测试数据。
--pause
a	我们继续。下一个议题是第四季度的招聘计划。
b	我们组还缺两个前端工程师，最好有 React 的经验。
me	客户端这边暂时不需要加人，但是需要一个测试工程师。
a	好的，我会把需求同步给人力资源部门，预算方面应该没有问题。
b	还有一个事情，下个月的团建活动大家有什么想法吗？
me	我觉得可以去郊外爬山，天气也比较凉快。
a	爬山不错，那就先这么定，具体时间我们在群里再投票。
b	最后提醒一下，下周一有一个安全培训，所有人都要参加。
me	收到，我会提醒客户端的同事。
a	好，今天的会就到这里，大家辛苦了。
EOF
)

# Synthesize each line once (16 kHz mono 16-bit, the capture's format).
n=0
lines=()
while IFS=$'\t' read -r who text; do
  if [[ "$who" == "--pause" ]]; then
    lines+=("--pause")
    continue
  fi
  case "$who" in
    me) voice=$voice_mic ;;
    a) voice=$voice_a ;;
    b) voice=$voice_b ;;
  esac
  n=$((n + 1))
  say -v "$voice" -o "$clips/$n.aiff" "$text"
  afconvert -f WAVE -d LEI16@16000 -c 1 "$clips/$n.aiff" "$clips/$n.wav"
  lines+=("$who	$voice	$clips/$n.wav	$text")
done <<<"$script"

printf '%s\n' "${lines[@]}" >"$clips/lines.tsv"
python3 -I - "$out" "$clips/lines.tsv" "$repeat" "$echo_leak" <<'PY'
import array, json, random, sys, wave
from datetime import datetime, timezone

out, lines, repeat, echo_leak = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4] == "1"
SR = 16000
SEGMENT = 60 * SR
PAUSE = 10 * SR
# Gaps between turns cycle through these (seconds): long pauses, quick hand-overs.
GAPS = [0.9, 0.35, 1.4, 0.6, 1.1, 0.45]

with open(lines, encoding="utf-8") as f:
    items = [line.rstrip("\n").split("\t") for line in f if line.strip()]
meeting = items * repeat

def load(path):
    with wave.open(path) as w:
        assert w.getframerate() == SR and w.getnchannels() == 1 and w.getsampwidth() == 2
        return array.array("h", w.readframes(w.getnframes()))

clips = {}
mic, system = array.array("h"), array.array("h")
expected, paused = [], []
t = int(1.5 * SR)  # the meeting starts a moment after recording does
for i, item in enumerate(meeting):
    if item == ["--pause"]:
        t += int(0.5 * SR)
        paused.append((t, t + PAUSE))
        t += PAUSE + int(0.8 * SR)
        continue
    who, voice, path, text = item
    samples = clips.setdefault(path, load(path))
    track = mic if who == "me" else system
    for buf in (mic, system):
        if len(buf) < t + len(samples):
            buf.extend([0] * (t + len(samples) - len(buf)))
    track[t:t + len(samples)] = samples
    expected.append({
        "track": "mic" if who == "me" else "system",
        "who": who,
        "voice": voice,
        "start": t * 1000 // SR,
        "end": (t + len(samples)) * 1000 // SR,
        "text": text,
    })
    t += len(samples) + int(GAPS[i % len(GAPS)] * SR)

end = t + 2 * SR
for buf in (mic, system):
    buf.extend([0] * (end - len(buf)))

def mix(a, b):
    return array.array("h", (max(-32768, min(32767, x + y)) for x, y in zip(a, b)))

if echo_leak:
    # Speakers into the microphone: 80 ms later and about 12 dB quieter.
    delay = int(0.08 * SR)
    leak = array.array("h", [0] * delay) + array.array("h", (x // 4 for x in system[: len(system) - delay]))
    mic = mix(mic, leak)

# A little noise, so silence is not digital zero (a 4 s pattern, repeated).
rng = random.Random(7)
pattern = [int(rng.gauss(0, 12)) for _ in range(4 * SR)]
noise = array.array("h", (pattern[k % len(pattern)] for k in range(end)))
mic, system = mix(mic, noise), mix(system, noise[::-1])

# Cut into segments like the capture: every 60 s, and at the pause (which has no files).
cuts, s = [], 0
for a, b in paused + [(end, end)]:
    while s < a:
        e = min(s + SEGMENT, a)
        cuts.append((s, e))
        s = e
    s = b

segments = []
for index, (a, b) in enumerate(cuts, start=1):
    entry = {"index": index, "startMs": a * 1000 // SR, "endMs": b * 1000 // SR}
    for name, buf in (("mic", mic), ("system", system)):
        filename = f"{name}-{index:04d}.wav"
        with wave.open(f"{out}/{filename}", "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes(buf[a:b].tobytes())
        entry[name] = filename
    segments.append(entry)

manifest = {
    "version": 1,
    "startedAt": datetime.now(timezone.utc).astimezone().isoformat(timespec="milliseconds"),
    "sampleRate": SR,
    "segmentSeconds": 60,
    "tracks": ["mic", "system"],
    "status": "stopped",
    "durationMs": end * 1000 // SR,
    "segments": segments,
    "marks": [],
    "paused": [{"fromMs": a * 1000 // SR, "toMs": b * 1000 // SR} for a, b in paused],
}
with open(f"{out}/manifest.json", "w") as f:
    json.dump(manifest, f, ensure_ascii=False)
    f.write("\n")
with open(f"{out}/expected.json", "w") as f:
    json.dump({"echo": echo_leak, "utterances": expected}, f, ensure_ascii=False, indent=1)
    f.write("\n")
speech = sum(u["end"] - u["start"] for u in expected) / 1000
print(f"{out}: {end / SR:.1f} s, {len(segments)} 段文件, 暂停 {len(paused)} 次, {len(expected)} 句 ({speech:.0f} s 语音)")
PY
