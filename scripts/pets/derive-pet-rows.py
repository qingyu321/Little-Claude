#!/usr/bin/env python3
"""Derive extra animation rows (run/sleep/wave/jump) from the idle row of a
spritesheet, so imported skins (which ship idle-only pet.json files) get
motion for engine states that would otherwise fall back to idle.

Pipeline: read ~/.tokenicode/pets/<id>/spritesheet.webp (idle row, 8×96px
frames) + pet.json → derive 4 rows → write back spritesheet.webp (768×480,
5 rows) + pet.json (states gains run/sleep/wave/jump) in BOTH the release
data dir and the .dev variant.

Usage:
    python scripts/pets/derive-pet-rows.py [skin_id ...]
    (default: all skins found under the pets dir)

Notes:
- Lossless webp output (the source is already a lossy webp — a second lossy
  pass would blur the pixels further).
- Rotation is capped so corners never leave the 96×96 frame (expand=False);
  if a row looks clipped, reduce the angle in ROW_DEFS.
"""

import json
import math
import os
import sys

from PIL import Image

FRAME_W, FRAME_H = 96, 96
IDLE_COLS = 8
DATA_DIRS = [
    os.path.join(os.path.expanduser("~"), ".tokenicode", "pets"),
    os.path.join(os.path.expanduser("~"), ".tokenicode.dev", "pets"),
]

# pet.json state rows to add: key → (frames, duration, loop)
ROW_DEFS = [
    ("run", 8, 120, True),    # walking: bob + slight rotation + weight shift
    ("sleep", 4, 600, True),  # sleeping: squash + drop + slow bob
    ("wave", 4, 150, False),  # waving: one-sided tilt + bob
    ("jump", 6, 130, False),  # jumping: vertical arc + landing squash
]

def derive_row(frames, key, count, duration, loop):
    row = Image.new("RGBA", (FRAME_W * count, FRAME_H), (0, 0, 0, 0))
    for f in range(count):
        t = 2 * math.pi * f / count
        src = frames[f % IDLE_COLS]
        if key == "run":
            bob = round(3 * math.sin(t))
            fr = src.rotate(
                math.degrees(0.03 * math.sin(t)),
                center=(FRAME_W / 2, FRAME_H / 2),
                resample=Image.BICUBIC,
                expand=False,
            )
            row.paste(fr, (f * FRAME_W, bob), fr)
        elif key == "sleep":
            bob = 1 if f % 2 else 0
            fr = src.resize((FRAME_W, round(FRAME_H * 0.92)), Image.BICUBIC)
            row.paste(fr, (f * FRAME_W, FRAME_H - round(FRAME_H * 0.92) + 4 + bob), fr)
        elif key == "wave":
            bob = round(2 * math.sin(t))
            fr = src.rotate(
                math.degrees(-0.05 * math.sin(t)),
                center=(FRAME_W * 0.3, FRAME_H * 0.55),
                resample=Image.BICUBIC,
                expand=False,
            )
            row.paste(fr, (f * FRAME_W, bob), fr)
        elif key == "jump":
            prog = f / (count - 1)
            bob = round(-18 * math.sin(prog * math.pi))  # rise then fall
            if f >= count - 1:
                # landing squash: scaleY compress, anchored to the bottom
                fr = src.resize((FRAME_W, round(FRAME_H * 0.88)), Image.BICUBIC)
                row.paste(fr, (f * FRAME_W, FRAME_H - round(FRAME_H * 0.88) + 4), fr)
            else:
                row.paste(src, (f * FRAME_W, bob), src)
    return row


def process_skin(pets_dir, skin_id):
    base = os.path.join(pets_dir, skin_id)
    sheet_path = os.path.join(base, "spritesheet.webp")
    json_path = os.path.join(base, "pet.json")
    if not (os.path.isfile(sheet_path) and os.path.isfile(json_path)):
        return None

    with Image.open(sheet_path) as img:
        sheet = img.convert("RGBA")
    with open(json_path, encoding="utf-8") as fh:
        cfg = json.load(fh)

    if sheet.width != FRAME_W * IDLE_COLS or sheet.height != FRAME_H:
        print(f"  ! {skin_id}: unexpected sheet size {sheet.size}, skip")
        return None
    if "run" in cfg.get("states", {}):
        print(f"  - {skin_id}: rows already derived, skip")
        return None

    frames = [sheet.crop((i * FRAME_W, 0, (i + 1) * FRAME_W, FRAME_H)) for i in range(IDLE_COLS)]
    rows = [sheet.copy()]  # row 0: idle as-is
    states = dict(cfg.get("states", {}))
    row_idx = 1
    for key, count, duration, loop in ROW_DEFS:
        rows.append(derive_row(frames, key, count, duration, loop))
        states[key] = {"row": row_idx, "frames": count, "duration": duration, "loop": loop}
        row_idx += 1

    out = Image.new("RGBA", (FRAME_W * IDLE_COLS, FRAME_H * len(rows)), (0, 0, 0, 0))
    for i, r in enumerate(rows):
        out.paste(r, (0, i * FRAME_H))
    out.save(sheet_path, "WEBP", lossless=True)

    cfg["states"] = states
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, ensure_ascii=False, indent=2)

    # Verify: sheet rows ↔ pet.json rows
    with Image.open(sheet_path) as chk:
        ok = chk.width == FRAME_W * IDLE_COLS and chk.height == FRAME_H * len(rows)
    print(f"  ✓ {skin_id}: {chk.width}×{chk.height} sheet, states: {', '.join(states)}" if ok else f"  ✗ {skin_id}: verify failed")
    return ok


def main():
    wanted = set(sys.argv[1:]) or None
    for pets_dir in DATA_DIRS:
        if not os.path.isdir(pets_dir):
            print(f"- missing data dir: {pets_dir}")
            continue
        print(f"== {pets_dir}")
        for entry in sorted(os.listdir(pets_dir)):
            if wanted is not None and entry not in wanted:
                continue
            process_skin(pets_dir, entry)
    print("done")


if __name__ == "__main__":
    main()
