#!/usr/bin/env python3
"""精确分析脸区域：闭眼线/嘴/腮红位置（2px 映射 + 深色像素聚类）。"""
import sys, os
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from PIL import Image

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_v6_base.png")
img = Image.open(BASE).convert("RGBA")
px = img.load()
W, H = img.size

def map2(px, x0, y0, x1, y1):
    """2px 级映射：x1-x0/2 列。字符：W白 S肤 C蓝 K深 R红 G灰 .=透明"""
    out = []
    for y in range(y0, y1, 2):
        line = []
        for x in range(x0, x1, 2):
            r, g, b, a = px[x, y]
            if a < 30:
                ch = "."
            elif r > 230 and g > 230 and b > 220:
                ch = "W"
            elif r > 235 and g > 200 and b > 160:
                ch = "S"
            elif r > 200 and g > 170 and b > 150:
                ch = "s"
            elif r > 180 and g < 150 and b < 160 and r > b + 40:
                ch = "R"
            elif b > 140 and b > r + 20:
                ch = "C"
            elif b > 100 and b > r + 15:
                ch = "c"
            elif r > 120 and g > 120 and b > 120:
                ch = "G"
            elif a > 60:
                ch = "K"
            else:
                ch = "."
            line.append(ch)
        out.append("".join(line))
    return out

print("=== 脸区域 x90-190, y190-260 (2px) ===")
for line in map2(px, 90, 190, 190, 260):
    print(line)

# 深色像素聚类（找闭眼线/嘴——在白色脸区内的深色块）
print("\n=== 脸区深色像素 (R,G,B 均<130) 聚类（x90-190 y190-260）===")
dark = []
for y in range(190, 260):
    for x in range(90, 190):
        r, g, b, a = px[x, y]
        if a > 100 and r < 130 and g < 130 and b < 130:
            dark.append((x, y))
# 简单聚类：按 y 带分组
if dark:
    ys = sorted(set(y for _, y in dark))
    bands = []
    cur = [ys[0]]
    for y in ys[1:]:
        if y - cur[-1] <= 3:
            cur.append(y)
        else:
            bands.append(cur)
            cur = [y]
    bands.append(cur)
    for band in bands:
        pts = [(x, y) for x, y in dark if band[0] <= y <= band[-1]]
        xs = [p[0] for p in pts]
        print(f"  y{band[0]}-{band[-1]}  x{min(xs)}-{max(xs)}  {len(pts)}px")

# 红色像素（腮红）
print("\n=== 红/粉像素 (r>180, b<160, r>b+40) 聚类 ===")
reds = []
for y in range(150, 280):
    for x in range(0, 200):
        r, g, b, a = px[x, y]
        if a > 100 and r > 180 and b < 170 and r > b + 40 and g < r:
            reds.append((x, y))
if reds:
    ys = sorted(set(y for _, y in reds))
    bands = []
    cur = [ys[0]]
    for y in ys[1:]:
        if y - cur[-1] <= 5:
            cur.append(y)
        else:
            bands.append(cur)
            cur = [y]
    bands.append(cur)
    for band in bands:
        pts = [(x, y) for x, y in reds if band[0] <= y <= band[-1]]
        xs = [p[0] for p in pts]
        print(f"  y{band[0]}-{band[-1]}  x{min(xs)}-{max(xs)}  {len(pts)}px")

# 发带区域确认（y84-115 是否有内容 + 是否白色）
print("\n=== 发带区 y84-115 x70-180 (2px) ===")
for line in map2(px, 70, 84, 180, 115):
    print(line)
