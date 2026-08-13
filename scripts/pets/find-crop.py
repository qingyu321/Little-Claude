#!/usr/bin/env python3
"""实验：确定 _v6_base.png 与原图 crop 的真实映射（滑动 x0/y0 找最高匹配）。"""
import sys, os
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from PIL import Image

SRC = r"C:\桌面\ai吊图\489a90b4c2d94db256eefdd7788394c43546384821127812.png"
BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_v6_base.png")
orig = Image.open(SRC).convert("RGBA")
base = Image.open(BASE).convert("RGBA")
bw, bh = base.size
print(f"基图 {bw}x{bh} 原图 {orig.size}")

# 基图 alpha mask
b_mask = [1 if base.getpixel((x, y))[3] > 128 else 0 for y in range(bh) for x in range(bw)]

best = []
for x0 in range(0, 460, 20):
    for y0 in range(0, 260, 20):
        # crop 高度固定 884？试多种
        pass

# 快速方案：假设 crop = (x0, y0, x0+Wc, y0+Hc)，Wc/Hc 比例 = 原图宽高比附近
# 主体是 884 高（y118-1002）。宽度未知。用 getbbox 猜？
# 直接全搜索：x0 0-500, y0 0-200, Wc 700-1200, Hc 700-1100 太慢。
# 简化：先找 y0/Hc（Y 轴确定），再找 x0/Wc。
# 其实用特征：基图左上 Zzz 碎片（x100-240 y14-34 有内容）在原图 y150-215。
# 先搜 Y：对 y0 in 0..300, Hc = 884：crop(x0=0, y0, 884, y0+884) 不行 x0 未定。
# 用全图信息太慢。改为逐 y 投影匹配：
# 原图在 y 方向的非背景（非白）分布 vs 基图分布。

def proj(img, y0, y1, step=2, thr=245):
    """返回该 y 条带的非白像素占比（背景是纯白）。"""
    counts = []
    for y in range(y0, y1, step):
        n = 0
        px = img.load()
        for x in range(0, img.width, 4):
            r, g, b = px[x, y][:3]
            if r < thr or g < thr or b < thr:
                n += 1
        counts.append(n)
    return counts

op = proj(orig, 0, orig.height)
bp = proj(base, 0, base.height)
# 归一化基图投影（放大到原图尺度）
import math
scale = orig.height / bh
best_y = None
best_score = -1
for y0 in range(0, orig.height - int(bh * scale)):
    score = 0
    for i, v in enumerate(bp):
        oy = int(y0 + i * scale)
        if oy < len(op):
            score += min(op[oy], v * 40)
    if score > best_score:
        best_score = score
        best_y = y0
print(f"Y 偏移 = {best_y}（score {best_score}），缩放系数 {scale}")

# X 方向同样
def projx(img, x0, x1, step=2, thr=245):
    counts = []
    px = img.load()
    for x in range(x0, x1, step):
        n = 0
        for y in range(0, img.height, 4):
            r, g, b = px[x, y][:3]
            if r < thr or g < thr or b < thr:
                n += 1
        counts.append(n)
    return counts

opx = projx(orig, 0, orig.width)
bpx = projx(base, 0, base.width)
sx = orig.width / bw
best_x = None
best_score = -1
for x0 in range(0, orig.width - int(bw * sx)):
    score = 0
    for i, v in enumerate(bpx):
        ox = int(x0 + i * sx)
        if ox < len(opx):
            score += min(opx[ox], v * 40)
    if score > best_score:
        best_score = score
        best_x = x0
print(f"X 偏移 = {best_x}（score {best_score}），缩放系数 {sx}")

# 验证：用最优 crop 重采样，对比基图
if best_y and best_x:
    wc = int(bw * sx)
    hc = int(bh * scale)
    crop = orig.crop((best_x, best_y, best_x + wc, best_y + hc))
    resized = crop.resize((bw, bh), Image.LANCZOS)
    same = 0
    tot = 0
    for y in range(0, bh, 3):
        for x in range(0, bw, 3):
            tot += 1
            pa, pb = base.getpixel((x, y))[3], resized.getpixel((x, y))[3]
            if (pa > 128) == (pb > 128):
                same += 1
    print(f"crop=({best_x},{best_y},{best_x+wc},{best_y+hc}) alpha mask 一致率 {same/tot:.1%}")
