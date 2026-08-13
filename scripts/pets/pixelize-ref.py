#!/usr/bin/env python3
"""
参考图 → 像素画管线：抠背景 → 主体方形裁剪 → 缩到目标尺寸 → 调色板量化。
用法: python pixelize-ref.py <img路径> <输出PNG> [目标尺寸] [颜色数]
"""
import sys

if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from PIL import Image, ImageFilter
import math

TARGET = int(sys.argv[3]) if len(sys.argv) > 3 else 160
NCOLORS = int(sys.argv[4]) if len(sys.argv) > 4 else 22
BG_DIST = 52  # 背景判定距离

img_path, out_path = sys.argv[1], sys.argv[2]
im = Image.open(img_path).convert("RGB")
w, h = im.size

# 背景色 = 四角均值
corners = [im.getpixel((5, 5)), im.getpixel((w - 6, 5)), im.getpixel((5, h - 6)), im.getpixel((w - 6, h - 6))]
bg = tuple(round(sum(c[k] for c in corners) / 4) for k in range(3))

def dist(c1, c2):
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(c1, c2)))

# 背景 mask：从图像边缘向内泛洪（背景色连通域）；角色身上的白色（围裙/发带）
# 被深蓝裙包围 → 泛洪进不来 → 保留。防止整块白色被当背景误删。
px = im.load()
bgmask = bytearray(w * h)
visited = bytearray(w * h)
stack = []
for x in range(w):
    stack.append(x)
    stack.append((h - 1) * w + x)
for y in range(h):
    stack.append(y * w)
    stack.append(y * w + w - 1)
while stack:
    i = stack.pop()
    if visited[i]:
        continue
    visited[i] = 1
    x, y = i % w, i // w
    if dist(px[x, y], bg) > BG_DIST:
        continue  # 前景色，泛洪停止
    bgmask[i] = 1
    for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
        if 0 <= nx < w and 0 <= ny < h and not visited[ny * w + nx]:
            stack.append(ny * w + nx)

# 前景 = 非背景（腐蚀 2px 去边界杂点）
mask = bytearray(w * h)
for i in range(w * h):
    if not bgmask[i]:
        mask[i] = 1
# 简单腐蚀：邻域 8 格有 ≥4 个背景 → 置背景（去单点噪点）
noise = bytearray(w * h)
for y in range(1, h - 1):
    row = y * w
    for x in range(1, w - 1):
        i = row + x
        if not mask[i]:
            continue
        nbg = 0
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                if bgmask[i + dy * w + dx]:
                    nbg += 1
        if nbg >= 5:
            noise[i] = 1
for i in range(w * h):
    if noise[i]:
        mask[i] = 0

# 连通域标注（BFS），保留最大域（角色主体），删除装饰/文字
def label_components(mask, w, h):
    comps = []
    visited = bytearray(len(mask))
    for start in range(len(mask)):
        if not mask[start] or visited[start]:
            continue
        stack = [start]
        visited[start] = 1
        pts = []
        while stack:
            i = stack.pop()
            pts.append(i)
            x, y = i % w, i // w
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= nx < w and 0 <= ny < h:
                    j = ny * w + nx
                    if mask[j] and not visited[j]:
                        visited[j] = 1
                        stack.append(j)
        if len(pts) >= 800:  # 过滤小连通域
            comps.append(pts)
    return comps

comps = label_components(mask, w, h)
print(f"连通域: {len(comps)} 个（>=800px）")
main = max(comps, key=len) if comps else []
print(f"主体像素: {len(main)}")

# 主域 mask
main_mask = bytearray(len(mask))
for i in main:
    main_mask[i] = 1

# 主域 bbox：用 99% 分位数截断（去掉纸张/问号等连体装饰的尾巴）
xs = [i % w for i in main]
ys = [i // w for i in main]
xs.sort(); ys.sort()
def pct(lst, p):
    return lst[min(len(lst) - 1, int(len(lst) * p))]
x0, x1 = pct(xs, 0.005), pct(xs, 0.995)
y0, y1 = pct(ys, 0.005), pct(ys, 0.995)
print(f"主体 bbox(p99): x{x0}-{x1} y{y0}-{y1} ({x1-x0}x{y1-y0})")

# 方形裁剪（中心对齐）
bw, bh = x1 - x0, y1 - y0
side = max(bw, bh)
side = min(side, int(side * 1.06))  # 外扩 6% 防切边
cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
cx0 = max(0, int(cx - side / 2))
cy0 = max(0, int(cy - side / 2))
cx1 = min(w, cx0 + side)
cy1 = min(h, cy0 + side)
cx0, cy0 = max(0, cx1 - side), max(0, cy1 - side)  # 左/上对齐保证方形
print(f"裁剪: ({cx0},{cy0})-({cx1},{cy1})")

crop = im.crop((cx0, cy0, cx1, cy1))
# 每行切片（mask 存 0/1 → putdata 前乘 255，否则 alpha 全 0）
m2 = bytearray(crop.size[0] * crop.size[1])
for yy in range(cy1 - cy0):
    src_start = (cy0 + yy) * w + cx0
    m2[yy * crop.size[0]:(yy + 1) * crop.size[0]] = main_mask[src_start:src_start + (cx1 - cx0)]
alpha = Image.new("L", crop.size, 0)
alpha.putdata([v * 255 for v in m2])
crop.putalpha(alpha)

# 边缘羽化（减少硬边锯齿）
alpha_img = alpha.filter(ImageFilter.GaussianBlur(0.6))
crop.putalpha(alpha_img)

# 缩到 TARGET（LANCZOS 保形状）
small = crop.resize((TARGET, TARGET), Image.LANCZOS)

# 量化：透明像素置白参与量化，再回填 alpha
a = small.getchannel("A")
rgb = small.convert("RGB")
q = rgb.quantize(colors=NCOLORS, method=Image.Quantize.MEDIANCUT).convert("RGBA")
q.putalpha(a)
q = q.convert("RGB")
q.putalpha(a)

# 输出
q.save(out_path)
print(f"✓ 输出 {out_path} {q.size} 调色板 {NCOLORS} 色")

# 调色板统计（RGB 像素计数）
qc = q.convert("RGBA")
qpx = qc.load()
counts = {}
for y in range(TARGET):
    for x in range(TARGET):
        r, g, b, al = qpx[x, y]
        if al < 128:
            continue
        key = (r, g, b)
        counts[key] = counts.get(key, 0) + 1
print("调色板（前 18 色，按面积）:")
for k, c in sorted(counts.items(), key=lambda kv: -kv[1])[:18]:
    print(f"  #{k[0]:02X}{k[1]:02X}{k[2]:02X}  {c}px")
