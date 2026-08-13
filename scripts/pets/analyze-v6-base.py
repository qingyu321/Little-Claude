#!/usr/bin/env python3
"""v6 基图诊断：字符画 + 透明缝隙检测 + 眼睛/嘴区域放大字符画。"""
import sys, os
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from PIL import Image

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_v6_base.png")
img = Image.open(BASE).convert("RGBA")
W, H = img.size
print(f"基图 {W}x{H}")

def ascii_map(px, x0, y0, x1, y1, cols=80, rows=None):
    """区域映射字符画：W白 S肤 C蓝 K深 R红 G灰 .=透明"""
    rows = rows or int((y1 - y0) * cols / (x1 - x0))
    out = []
    for r in range(rows):
        line = []
        for c in range(cols):
            x = x0 + int((c + 0.5) * (x1 - x0) / cols)
            y = y0 + int((r + 0.5) * (y1 - y0) / rows)
            R, G, B, A = px[x, y]
            if A < 30:
                ch = "."
            elif R > 230 and G > 230 and B > 220:
                ch = "W"
            elif R > 235 and G > 200 and B > 160:
                ch = "S"
            elif R > 200 and G > 170 and B > 150:
                ch = "s"
            elif B > 140 and B > R + 20:
                ch = "C"
            elif B > 100 and B > R + 15:
                ch = "c"
            elif R > 180 and G < 140:
                ch = "R"
            elif R > 120 and G > 120 and B > 120:
                ch = "G"
            else:
                ch = "K"
            line.append(ch)
        out.append("".join(line))
    return out

px = img.load()

print("\n=== 全图 80x80 字符画 ===")
for line in ascii_map(px, 0, 0, W, H):
    print(line)

print("\n=== 透明缝隙检测（逐 y 统计非透明像素 x 范围，找头身断点）===")
runs = []
prev = None
for y in range(H):
    xs = [x for x in range(W) if px[x, y][3] >= 30]
    if not xs:
        continue
    span = (min(xs), max(xs), len(xs))
    key = f"{span[0]}-{span[1]}"
    if key != prev:
        runs.append((y, key, span[2]))
        prev = key
for y, key, cnt in runs:
    print(f"  y={y:3d}  x{key}  {cnt}px")

print("\n=== 眼睛区域放大字符画 (x100-220, y170-235, 60x26) ===")
for line in ascii_map(px, 100, 170, 220, 235, cols=60):
    print(line)

print("\n=== 嘴区域放大字符画 (x95-165, y195-230, 35x18) ===")
for line in ascii_map(px, 95, 195, 165, 230, cols=35):
    print(line)

print("\n=== 右上区域 (x230-320, y60-160) 是否有文字残留 ===")
for line in ascii_map(px, 230, 60, 320, 160, cols=45):
    print(line)
