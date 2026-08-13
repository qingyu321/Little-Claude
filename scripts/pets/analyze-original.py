#!/usr/bin/env python3
"""分析原图各区域，确认 Zzz/deepsleep/发带/尾巴真实位置（原图 1254 坐标）。"""
import sys, os
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from PIL import Image

SRC = r"C:\桌面\ai吊图\489a90b4c2d94db256eefdd7788394c43546384821127812.png"
img = Image.open(SRC).convert("RGBA")
W, H = img.size
px = img.load()
print(f"原图 {W}x{H}")

def map2(px, x0, y0, x1, y1, step=4):
    """step 级映射。字符：W白 S肤 C蓝 K深 R红 G灰 .=透明/背景"""
    cols = (x1 - x0) // step
    out = []
    for y in range(y0, y1, step):
        line = []
        for x in range(x0, x1, step):
            r, g, b, a = px[x, y]
            if a < 30:
                ch = "."
            elif r > 235 and g > 235 and b > 225:
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

print("\n=== A. 头顶 Zzz 区 (x250-700, y110-260, step=8) ===")
for line in map2(px, 250, 110, 700, 260, step=8):
    print(line)

print("\n=== B. 发带区 (x290-760, y250-580, step=8) ===")
for line in map2(px, 290, 250, 760, 580, step=8):
    print(line)

print("\n=== C. 右上 deepsleep/尾巴区 (x650-884, y310-560, step=6) ===")
for line in map2(px, 650, 310, 884, 560, step=6):
    print(line)

print("\n=== D. 右下身体右缘 (x640-884, y690-860, step=6) ===")
for line in map2(px, 640, 690, 884, 860, step=6):
    print(line)

print("\n=== E. 左中 腮红/眼 区 (x300-660, y560-760, step=6) ===")
for line in map2(px, 300, 560, 660, 760, step=6):
    print(line)
