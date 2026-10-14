#!/usr/bin/env python3
"""Scores a transcript.json against a fixture from make-fixture.sh.

    python3 scripts/check-transcript.py <fixture_dir> <transcript.json>

Checks the shape against packages/shared (Transcript/Speaker/Segment), then reports
character error rate per track and voice, how the system voices map to speaker ids,
and how far segment starts are from where the utterances were placed.
Exit code 1 when the shape is wrong.
"""
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

fixture, transcript_path = Path(sys.argv[1]), Path(sys.argv[2])
expected = json.loads((fixture / "expected.json").read_text())
utterances = expected["utterances"]
t = json.loads(Path(transcript_path).read_text())

problems = []


def check(ok, message):
    if not ok:
        problems.append(message)


# Shape: packages/shared/src/meeting.ts
check(set(t) == {"meetingId", "language", "scene", "speakers", "segments"}, f"top-level keys: {sorted(t)}")
check(t.get("scene") in ("in-person", "online"), f"scene {t.get('scene')!r}")
check(t.get("meetingId") == fixture.name, f"meetingId {t.get('meetingId')!r} != folder name {fixture.name!r}")
check(t.get("language") == "zh", "language should be zh")
speakers = {s["id"]: s for s in t["speakers"]}
for s in t["speakers"]:
    check(set(s) <= {"id", "label", "track", "personId", "source", "confidence"} and {"id", "label", "track", "personId", "source"} <= set(s), f"speaker keys {sorted(s)}")
    check(re.fullmatch(r"S\d+", s["id"]) is not None, f"speaker id {s['id']}")
    check(s["personId"] is None, "personId should be null")
    if s["source"] == "self":
        check((s["id"], s["label"], s["track"]) == ("S1", "我", "mic"), f"the person recording is {s}")
    else:
        check(s["source"] == "unknown" and s["label"] == f"说话人 {s['id'][1:]}", f"diarized speaker {s}")
        check(s["track"] == "system" or t.get("scene") == "in-person", f"mic speaker {s} outside an in-person meeting")
previous = -1
for i, seg in enumerate(t["segments"], start=1):
    check(set(seg) == {"id", "speakerId", "track", "start", "end", "text"}, f"segment keys {sorted(seg)}")
    check(seg["id"] == f"seg-{i:04d}", f"segment id {seg['id']} at position {i}")
    check(seg["speakerId"] in speakers, f"{seg['id']}: unknown speaker {seg['speakerId']}")
    check(speakers.get(seg["speakerId"], {}).get("track") == seg["track"], f"{seg['id']}: track differs from its speaker")
    check(isinstance(seg["start"], int) and isinstance(seg["end"], int) and 0 <= seg["start"] <= seg["end"], f"{seg['id']}: times")
    check(seg["start"] >= previous, f"{seg['id']}: not sorted by start")
    check(seg["text"].strip() != "", f"{seg['id']}: empty text")
    previous = seg["start"]
used = {seg["speakerId"] for seg in t["segments"]}
check(all(speakers[s]["source"] == "self" or s in used for s in speakers), "a diarized speaker has no segments")


def norm(text):
    return [c for c in text.lower() if c.isalnum()]


def edits(a, b):
    row = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        diag, row[0] = row[0], i
        for j, y in enumerate(b, 1):
            diag, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, diag + (x != y))
    return row[-1]


def overlap(a, b):
    return max(0, min(a["end"], b["end"]) - max(a["start"], b["start"]))


print(f"{len(t['segments'])} segments, speakers: {', '.join(sorted(speakers))}")

# Text: everything said on a track, in order, against everything recognised on it.
for track in ("mic", "system"):
    ref = [c for u in utterances if u["track"] == track for c in norm(u["text"])]
    hyp = [c for s in t["segments"] if s["track"] == track for c in norm(s["text"])]
    if ref:
        print(f"CER {track:6}: {edits(ref, hyp) / len(ref):6.2%}  ({len(ref)} chars)")

# Per voice: the segments that overlap that voice's utterances most.
by_voice = defaultdict(lambda: ([], []))
for u in utterances:
    by_voice[u["voice"]][0].extend(norm(u["text"]))
for s in t["segments"]:
    best = max((u for u in utterances if u["track"] == s["track"]), key=lambda u: overlap(u, s), default=None)
    if best and overlap(best, s) > 0:
        by_voice[best["voice"]][1].extend(norm(s["text"]))
for voice, (ref, hyp) in sorted(by_voice.items()):
    print(f"  {voice:40} CER {edits(ref, hyp) / max(1, len(ref)):6.2%}")

# Diarization: milliseconds of each voice under each diarized speaker id, on its own track.
matrix = defaultdict(lambda: defaultdict(int))
for s in t["segments"]:
    if speakers[s["speakerId"]]["source"] == "self":
        continue
    for u in utterances:
        if u["track"] == s["track"]:
            matrix[u["voice"]][s["speakerId"]] += overlap(u, s)
print("voices -> diarized speaker ids (seconds of overlap):")
for voice, ids in sorted(matrix.items()):
    print(f"  {voice:40} " + ", ".join(f"{k}: {v / 1000:.1f}" for k, v in sorted(ids.items())))
total = sum(v for ids in matrix.values() for v in ids.values())
# Purity: each id counted for the voice it mostly carries.
per_id = defaultdict(lambda: defaultdict(int))
for voice, ids in matrix.items():
    for k, v in ids.items():
        per_id[k][voice] += v
pure = sum(max(v.values()) for v in per_id.values())
print(f"diarization purity {pure / max(1, total):.1%}, {len(per_id)} ids for {len(matrix)} voices")

# Timing: utterances that start a segment, against where they were placed.
deltas = []
for u in utterances:
    starts = [s for s in t["segments"] if s["track"] == u["track"] and overlap(u, s) > 0]
    if starts:
        first = min(starts, key=lambda s: s["start"])
        if abs(first["start"] - u["start"]) < 1500:
            deltas.append(first["start"] - u["start"])
if deltas:
    print(f"segment start vs placed: mean {sum(deltas) / len(deltas):+.0f} ms, max |{max(map(abs, deltas))}| ms over {len(deltas)} utterances")

if expected.get("echo"):
    leaked = [s for s in t["segments"] if s["track"] == "mic"
              and not any(overlap(u, s) for u in utterances if u["track"] == "mic")]
    print(f"echo: {len(leaked)} mic segments without the user speaking" + "".join(f"\n  {s['id']} {s['text']}" for s in leaked))

if problems:
    print("SHAPE PROBLEMS:\n  " + "\n  ".join(problems))
    sys.exit(1)
print("shape OK")
