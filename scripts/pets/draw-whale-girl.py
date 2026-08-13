#!/usr/bin/env python3
"""
DeepSeek 鲸鱼娘桌宠皮肤 — v5 高清还原版（2026-08-13）

用户提供参考图（489a90b4...png，趴睡 Q 版鲸鱼娘）：
- 配色：头发 #2C3E6B → 发尾 #5B8DEF 渐变；女仆装 #1A2744；蕾丝/围裙纯白 + #F0F3F8 阴影；
  发带两端对称 #4A90E2 蝴蝶结；腮红 #FFB6C1；金色刺绣 #C1A86B；鲸尾同发色 + 纯白腹
- 结构：齐刘海（中短侧长内扣）、及肩发尾波浪卷、宽白蕾丝发带（头顶后侧环绕，不遮额）、
  双层白蕾丝环形领口荷叶边、收口袖口+金铆钉带、白围裙（弧形上缘）+浅蓝鲸鱼+金色星星、
  三层白荷叶边裙摆、45° 上翘白腹鲸尾、趴睡（双手枕脸馒头手、青蛙腿）
- 姿态：所有 8 状态保持趴睡构图（idle 睁眼呼吸 / sleep 完全还原闭眼+口水）

渲染：256×256 帧，4x 超采样 + LANCZOS（平滑插画，非像素）；线性渐变 + 贝塞尔 + 半透明。
用法: python scripts/pets/draw-whale-girl.py
"""

import json
import math
import os
import sys

if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from PIL import Image, ImageDraw

W, H, COLS = 256, 256, 8
SS = 4
NAME = "deepseek-whale-girl"
DISPLAY = "鲸鱼娘 · DeepSeek"
ANCHOR = 238  # squash 锚底

# ---------------------------------------------------------------- palette ---
PAL = {
    "skin": (255, 226, 200, 255),
    "skin_shade": (243, 210, 178, 255),
    "hair_top": (44, 62, 107, 255),       # #2C3E6B 深海蓝
    "hair_mid": (70, 100, 170, 255),
    "hair_tip": (91, 141, 239, 255),      # #5B8DEF 蔚蓝
    "hair_hi": (150, 185, 240, 160),
    "dress_top": (26, 39, 68, 255),       # #1A2744
    "dress_bot": (34, 50, 88, 255),
    "dress_dark": (16, 24, 42, 255),
    "apron": (255, 255, 255, 255),
    "apron_shade": (240, 243, 248, 255),  # #F0F3F8
    "lace": (255, 255, 255, 255),
    "gold": (193, 168, 107, 255),         # #C1A86B
    "bow": (74, 144, 226, 255),           # #4A90E2
    "bow_l": (140, 190, 245, 255),
    "gem": (150, 180, 235, 255),
    "iris_m": (110, 185, 245, 255),       # 睁眼天蓝
    "pupil": (24, 38, 66, 255),
    "eye_line": (28, 32, 48, 255),
    "cheek": (255, 182, 193, 150),        # #FFB6C1
    "ink": (28, 32, 48, 255),
    "mouth_in": (150, 60, 70, 255),       # 口腔深红
    "tail_top": (44, 62, 107, 255),       # 同发色
    "tail_bot": (34, 50, 88, 255),
    "tail_belly": (255, 255, 255, 255),
    "sleeve": (26, 39, 68, 255),
    "sleeve_lace": (255, 255, 255, 255),
    "water": (191, 232, 255, 255),
    "water_d": (130, 200, 240, 255),
    "drool": (228, 244, 255, 235),        # 口水半透明（更透白，与头发区分）
}

# ------------------------------------------------------------- state table ---
STATES = [
    ("idle",    8, 150, True),
    ("run",     8, 120, True),
    ("sleep",   4, 600, True),
    ("wave",    4, 150, False),
    ("jump",    6, 130, False),
    ("waiting", 4, 160, True),
    ("review",  4, 200, True),
    ("failed",  4, 200, False),
]

TAIL_PIVOT = (150, 200)  # 尾巴旋转锚点


def frame_params(state: str, frame: int, n: int) -> dict:
    p = {
        "bob": 0.0, "tilt": 0.0, "squash": 1.0, "tail": 0.0,
        "eye": "open", "mouth": "smile", "arm": "down",
        "head_dy": 0, "drool": False, "_frame": frame,
    }
    if state == "idle":
        p["bob"] = -abs(math.sin((frame / 8) * math.pi * 2)) * 3
        p["tail"] = math.sin((frame / 6) * math.pi * 2) * 0.10
        if frame >= 7:
            p["eye"] = "closed"
    elif state == "run":
        p["bob"] = -abs(math.sin((frame / 8) * math.pi * 2)) * 7
        p["sway"] = 5 if frame % 2 else -5          # 趴姿左右蠕动
        p["tail"] = math.sin((frame / 4) * math.pi * 2) * 0.16
        p["eye"] = "open"
        p["mouth"] = "open"
    elif state == "sleep":
        p["squash"] = 0.94
        p["eye"] = "closed"
        p["drool"] = True                            # 口水（还原参考图）
        p["tail"] = -0.08
        p["bob"] = (0, -1, -2, -1)[frame]
        p["mouth"] = "open"
    elif state == "wave":
        p["bob"] = -2
        p["eye"] = "happy"
        p["arm"] = "wave"
        p["arm_swing"] = math.sin((frame / (n - 1)) * math.pi * 2) * 5
        p["tail"] = math.sin((frame / 2) * math.pi) * 0.10
    elif state == "jump":
        arc = math.sin((frame / (n - 1)) * math.pi)
        if frame == n - 1:
            return {**p, "squash": 0.78, "bob": 0, "eye": "happy", "mouth": "open"}
        return {**p, "bob": -arc * 22, "squash": 0.97, "eye": "happy",
                "mouth": "open", "tail": math.sin((frame / 2) * math.pi) * 0.10}
    elif state == "waiting":
        p["tilt"] = 4
        p["eye"] = "wide"
        p["mouth"] = "o"
        p["bob"] = (0, -2, 0, -2)[frame]
        p["tail"] = math.sin((frame / 2) * math.pi) * 0.10
    elif state == "review":
        p["eye"] = "scan"
        p["eye_scan"] = (-5, 0, 5, 0)[frame]
        p["bob"] = (0, -1, 0, -1)[frame]
    elif state == "failed":
        p["head_dy"] = 4 + (0, 1, 2, 1)[frame]
        p["bob"] = (0, -1, -2, -1)[frame]
        p["eye"] = "open"
        p["mouth"] = "frown"
        p["tail"] = -0.06
    return p


# ------------------------------------------------------- render primitives ---
def new_canvas():
    return Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0))


def ell(d, xy, fill=None, outline=None, width=1):
    x0, y0, x1, y1 = xy
    d.ellipse((min(x0, x1) * SS, min(y0, y1) * SS, max(x0, x1) * SS, max(y0, y1) * SS),
              fill=fill, outline=outline, width=max(1, round(width * SS)))


def poly(d, pts, fill=None):
    d.polygon([(x * SS, y * SS) for x, y in pts], fill=fill)


def line(d, pts, fill, width=1):
    d.line([(x * SS, y * SS) for x, y in pts],
           fill=fill, width=max(1, round(width * SS)))


def qbez(p0, p1, p2, steps=14):
    out = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        out.append((u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
                    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]))
    return out


def cbez(p0, p1, p2, p3, steps=18):
    out = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        out.append((u ** 3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0],
                    u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1]))
    return out


def rot(px, py, cx, cy, a):
    dx, dy = px - cx, py - cy
    ca, sa = math.cos(a), math.sin(a)
    return (cx + dx * ca - dy * sa, cy + dx * sa + dy * ca)


_GRADS = {}


def grad_layer(c1, c2, axis="v"):
    key = (c1, c2, axis)
    if key not in _GRADS:
        w, h = W * SS, H * SS
        g = Image.new("RGB", (w, h))
        gd = ImageDraw.Draw(g)
        n = w if axis == "h" else h
        for i in range(n):
            t = i / max(1, n - 1)
            col = tuple(round(c1[k] + (c2[k] - c1[k]) * t) for k in range(3))
            if axis == "v":
                gd.line((0, i, w, i), fill=col)
            else:
                gd.line((i, 0, i, h), fill=col)
        _GRADS[key] = g
    return _GRADS[key]


def fill_grad(img, shape_fn, c1, c2, axis="v"):
    m = Image.new("L", (W * SS, H * SS), 0)
    shape_fn(ImageDraw.Draw(m))
    img.paste(grad_layer(c1, c2, axis), (0, 0), m)


def ym(y, p):
    return ANCHOR - (ANCHOR - y) * p["squash"] + p["bob"]


def xh(x, p, cx=128.0):
    return x + (x - cx) * (p.get("tilt", 0) / 40.0)


_CTX_IMG = None


# ------------------------------------------------------------- components ---
# 趴姿构图（参考图）：大头横卧 x70-190 y90-165，双手枕脸，裙体 y170-220，尾 45° 上翘
def draw_tail(d, p):
    """45° 上翘鲸尾（同发色 + 纯白腹 + 浅灰阴影），从身体右后侧伸出。"""
    cx, cy = TAIL_PIVOT[0], ym(TAIL_PIVOT[1], p)
    a = p["tail"]

    def t(x, y):
        y = ym(y, p)
        return rot(x, y, cx, cy, a)

    # 尾柄（粗）
    stem = cbez(t(150, 196), t(180, 190), t(205, 172), t(212, 150), 16)
    line(d, stem, PAL["tail_top"], 16)
    # 尾鳍上瓣（45° 上翘，参考图角度更陡）
    fin_up = cbez(t(205, 158), t(230, 130), t(244, 96), t(228, 88), 16)
    poly(d, fin_up + [t(205, 158)], fill=PAL["tail_top"])
    # 尾鳍上瓣渐变高光
    fin_hi = cbez(t(210, 152), t(230, 128), t(238, 102), t(226, 94), 14)
    poly(d, fin_hi + [t(210, 152)], fill=(70, 95, 155, 200))
    # 尾鳍下瓣
    fin_dn = cbez(t(212, 172), t(236, 174), t(248, 154), t(238, 144), 14)
    poly(d, fin_dn + [t(212, 172)], fill=PAL["tail_top"])
    # 白腹（宽条，近体宽远窄）
    belly = cbez(t(150, 206), t(182, 200), t(208, 182), t(222, 160), 16)
    poly(d, belly + list(reversed(stem)), fill=PAL["tail_belly"])
    # 白腹浅灰阴影
    line(d, cbez(t(156, 202), t(186, 196), t(210, 178), t(220, 160), 14), (225, 230, 240, 255), 2)
    # 白描边
    line(d, qbez(t(228, 104), t(238, 122), t(228, 138), 10), (255, 255, 255, 255), 2)


def draw_body(d, p):
    """趴姿身体：深蓝裙 + 三层白荷叶边裙摆（蓬松）+ 白围裙。"""
    def fy(y):
        return ym(y, p)

    bx = p.get("sway", 0)
    # 裙体（趴姿扁平椭圆 + 侧裙）
    skirt = cbez((96 + bx, fy(165)), (88 + bx, fy(185)), (90, fy(205)), (98, fy(215)), 14)
    skirt += [(175, fy(215)), (182, fy(205)), (185 + bx, fy(185)), (178 + bx, fy(165))]
    skirt += list(reversed(cbez((178 + bx, fy(165)), (150 + bx, fy(155)), (110 + bx, fy(155)), (96 + bx, fy(165)), 12)))
    fill_grad(_CTX_IMG, lambda gd: poly(gd, skirt, fill=255), PAL["dress_top"], PAL["dress_bot"], "v")
    # 三层白荷叶边裙摆（参考图：至少三层叠加蓬松，层距加大 + 每层阴影线）
    for layer, y_base in ((0, fy(210)), (1, fy(219)), (2, fy(228))):
        pts = []
        for i in range(26):
            x = 90 + bx + (94) * i / 25
            y = y_base + math.sin((i / 25) * math.pi * 4 + layer * 1.3) * 2.8
            pts.append((x, y))
        top_line = []
        for i in range(26):
            x = 90 + bx + (94) * i / 25
            top_line.append((x, y_base - 5 + math.sin((i / 25) * math.pi * 4 + layer * 1.3) * 1.6))
        poly(d, pts + list(reversed(top_line)), fill=PAL["lace"] if layer < 2 else PAL["apron_shade"])
        line(d, pts, (196, 212, 232, 255), 1.8)
        line(d, top_line, (220, 230, 244, 255), 1.4)
    # 白围裙（趴姿：身体前侧小围裙）
    a0, a1 = 108 + bx, 164 + bx
    d.rounded_rectangle((a0 * SS, fy(166) * SS, a1 * SS, fy(196) * SS),
                        radius=8 * SS, fill=PAL["apron"],
                        outline=PAL["apron_shade"], width=2)
    # 围裙浅蓝鲸鱼轮廓 + 金色星星（参考图刺绣）
    wx, wy = a0 + 16, fy(172)
    ell(d, (wx, wy, wx + 26, wy + 16), fill=(150, 195, 245, 200), outline=(110, 170, 230, 255), width=1.5)
    poly(d, [(wx + 22, wy + 5), (wx + 31, wy + 2), (wx + 28, wy + 11)], fill=(150, 195, 245, 200))
    for sxx, syy in ((a1 - 12, fy(182)), (a0 + 8, fy(188)), (a0 + 24, fy(192))):
        r = 2.6
        for k in range(5):
            a = k * (2 * math.pi / 5) - math.pi / 2
            x0 = sxx + math.cos(a) * r
            y0 = syy + math.sin(a) * r
            x1 = sxx + math.cos(a + math.pi / 5) * r * 0.45
            y1 = syy + math.sin(a + math.pi / 5) * r * 0.45
            d.line((x0 * SS, y0 * SS, x1 * SS, y1 * SS), fill=PAL["gold"], width=max(1, round(1 * SS)))


def draw_arms(d, p):
    """双手枕脸（馒头手，参考图特征）；wave 时右臂抬起。"""
    def fy(y):
        return ym(y, p)

    if p["arm"] == "wave":
        # 右臂抬起挥手
        bx = 150
        hy = 128 + p.get("arm_swing", 0) * 2
        arm = qbez((165, fy(180)), (185, fy(160)), (bx, hy), 12)
        line(d, arm, PAL["sleeve"], 14)
        ell(d, (bx - 10, hy - 10, bx + 10, hy + 10), fill=PAL["sleeve_lace"])
        ell(d, (bx - 6, hy - 6, bx + 6, hy + 6), fill=PAL["skin"])
        return
    # 默认：双手枕在脸下方（两个馒头手 + 袖口白蕾丝）
    for sgn in (-1, 1):
        sx = 128 + sgn * 34
        ell(d, (sx - 22, fy(178), sx + 22, fy(208)), fill=PAL["sleeve"])
        ell(d, (sx - 26, fy(182), sx + 26, fy(200)), fill=PAL["sleeve"])
        ell(d, (sx - 16, fy(196), sx + 16, fy(214)), fill=PAL["sleeve_lace"])
        ell(d, (sx - 12, fy(202), sx + 12, fy(218)), fill=PAL["skin"])


def draw_head(d, p):
    """大头横卧（1:1 头身比，参考图）。"""
    def hx(x):
        return xh(x, p)

    def hy(y):
        return ym(y, p) + p["head_dy"]

    ell(d, (hx(68), hy(88), hx(190), hy(166)), fill=PAL["skin"])
    ell(d, (hx(66), hy(92), hx(76), hy(158)), fill=PAL["skin_shade"])


def draw_hair_front(d, p):
    """刘海 + 发尾卷 + 宽白蕾丝发带 + 两端对称蝴蝶结（参考图）。"""
    def hx(x):
        return xh(x, p)

    def hy(y):
        return ym(y, p) + p["head_dy"]

    # 刘海（齐刘海中短侧长，内扣，覆盖头顶 y84-100）
    fringe = [(hx(70), hy(86))]
    fringe += qbez((hx(70), hy(86)), (hx(72), hy(100)), (hx(82), hy(104)), 8)
    x0, x1 = 82, 178
    for i in range(4):
        xa = x0 + (x1 - x0) * i / 4
        xb = x0 + (x1 - x0) * (i + 1) / 4
        for t in range(9):
            u = t / 8
            x = xa + (xb - xa) * u
            y = 98 + math.sin(math.pi * u) * 4 - (0 if i != 1 else 3)   # 中间略短
            fringe.append((hx(x), hy(y)))
    fringe += qbez((hx(178), hy(104)), (hx(188), hy(100)), (hx(188), hy(86)), 8)
    fringe += [(hx(70), hy(86))]
    fill_grad(_CTX_IMG, lambda gd: poly(gd, fringe, fill=255), PAL["hair_top"], PAL["hair_mid"], "v")
    line(d, qbez((hx(82), hy(90)), (hx(125), hy(87)), (hx(170), hy(90)), 14), PAL["hair_hi"], 3)
    # 刘海下缘叠发尾亮色（渐变层次，mimo 建议）
    fringe_tip = qbez((hx(84), hy(99)), (hx(120), hy(95)), (hx(176), hy(99)), 16)
    line(d, fringe_tip, PAL["hair_tip"], 2.5)

    # 发尾卷（两侧及肩波浪卷，参考图 1/3 卷曲，亮蔚蓝发尾加粗）
    for sgn in (-1, 1):
        curl = cbez((hx(128 + sgn * 44), hy(148)), (hx(128 + sgn * 56), hy(166)),
                    (hx(128 + sgn * 54), hy(188)), (hx(128 + sgn * 42), hy(196)), 12)
        fill_grad(_CTX_IMG, lambda gd, c=curl: poly(gd, c + [(hx(128 + sgn * 42), hy(196))], fill=255),
                  PAL["hair_mid"], PAL["hair_tip"], "v")
        line(d, qbez((hx(128 + sgn * 50), hy(168)), (hx(128 + sgn * 58), hy(184)),
                     (hx(128 + sgn * 46), hy(193)), 8), PAL["hair_tip"], 4)
    # 后侧发（头顶两侧，盖过头顶）
    for sgn in (-1, 1):
        side = qbez((hx(128 + sgn * 52), hy(92)), (hx(128 + sgn * 62), hy(120)),
                    (hx(128 + sgn * 55), hy(150)), 12)
        line(d, side, PAL["hair_top"], 14)

    # 宽白蕾丝发带（头顶后侧环绕，波浪边缘，不遮额头；参考图）
    bx0, bx1 = 86, 172
    for i in range(17):
        x = bx0 + (bx1 - bx0) * i / 16
        r = 3.4 + math.sin((i / 16) * math.pi * 4) * 1.4
        ell(d, (hx(x) - r, hy(112) - r, hx(x) + r, hy(112) + r), fill=(255, 255, 255, 255))
    d.rounded_rectangle((hx(82) * SS, hy(108) * SS, hx(176) * SS, hy(117) * SS),
                        radius=4 * SS, fill=(255, 255, 255, 255))
    line(d, cbez((hx(84), hy(116)), (hx(120), hy(113)), (hx(140), hy(113)), (hx(174), hy(116)), 14),
         PAL["apron_shade"], 1.5)
    # 两端对称蓝蝴蝶结（参考图：一对，发带两端，放大为视觉焦点）
    for sgn in (-1, 1):
        bxx = hx(128 + sgn * 44)
        byy = hy(111)
        for dx in (-9, 4):
            d.rounded_rectangle(((bxx + dx - 5.5) * SS, (byy - 5.5) * SS, (bxx + dx + 5.5) * SS, (byy + 5.5) * SS),
                                radius=2.4 * SS, fill=PAL["bow"])
        ell(d, (bxx - 3.2, byy - 3.2, bxx + 3.2, byy + 3.2), fill=PAL["bow_l"])
        ell(d, (bxx - 1.4, byy - 1.4, bxx + 0.4, byy + 0.4), fill=(255, 255, 255, 220))
        line(d, qbez((bxx, byy + 5), (bxx - 2.5, byy + 11), (bxx - 1.5, byy + 15)), PAL["bow"], 2.4)
        line(d, qbez((bxx, byy + 5), (bxx + 2.5, byy + 11), (bxx + 1.5, byy + 15)), PAL["bow"], 2.4)


def draw_features(d, p):
    """眼睛 + 腮红 + 嘴 + 口水（sleep 还原参考图）。"""
    def hx(x):
        return xh(x, p)

    def hy(y):
        return ym(y, p) + p["head_dy"]

    eye_y = hy(136)
    for ex in (hx(112), hx(146)):
        if p["eye"] == "closed":
            # 闭眼：向下弯曲饱满弧线 + 上睫毛（参考图）
            line(d, qbez((ex - 12, eye_y), (ex, eye_y + 7), (ex + 12, eye_y), 12), PAL["eye_line"], 4)
            for sgn in (-1, 1):
                line(d, [(ex + sgn * 6, eye_y - 4), (ex + sgn * 9, eye_y - 2)], PAL["eye_line"], 2)
            continue
        if p["eye"] == "happy":
            line(d, qbez((ex - 12, eye_y + 2), (ex, eye_y - 8), (ex + 12, eye_y + 2), 12), PAL["eye_line"], 4)
            continue
        sx = p.get("eye_scan", 0)
        r = 15 if p["eye"] == "wide" else 13
        ell(d, (ex + sx - r, eye_y - r, ex + sx + r, eye_y + r), fill=(255, 255, 255, 255))
        ell(d, (ex + sx - r * 0.85, eye_y - r * 0.85, ex + sx + r * 0.85, eye_y + r * 0.85), fill=PAL["iris_m"])
        poly(d, [(ex + sx - r * 0.36, eye_y - r * 0.1), (ex + sx + r * 0.36, eye_y - r * 0.1),
                 (ex + sx + r * 0.36, eye_y + r * 0.85), (ex + sx - r * 0.36, eye_y + r * 0.85)], fill=PAL["pupil"])
        ell(d, (ex + sx - 5, eye_y - 7.5, ex + sx + 1.5, eye_y - 1), fill=(255, 255, 255, 250))
        ell(d, (ex + sx + 3.5, eye_y + 2.5, ex + sx + 6.5, eye_y + 5.5), fill=(255, 255, 255, 240))
        line(d, qbez((ex - r - 2.5, eye_y - r * 0.5), (ex + sx, eye_y - r - 2), (ex + r + 2.5, eye_y - r * 0.5), 12),
             PAL["eye_line"], 4)
        for sgn in (-1, 1):
            line(d, [(ex + sx + sgn * r * 0.7, eye_y + r * 0.75), (ex + sx + sgn * r * 0.98, eye_y + r * 0.55)],
                 PAL["eye_line"], 2.4)

    # 腮红（椭圆晕染，双眼下）
    ell(d, (hx(88), hy(146), hx(106), hy(158)), fill=PAL["cheek"])
    ell(d, (hx(152), hy(146), hx(170), hy(158)), fill=PAL["cheek"])

    # 嘴（趴姿：微张倒 U 形，口腔深红；sleep 垂口水）
    my = hy(152)
    if p["mouth"] == "smile":
        line(d, qbez((120, my), (129, my + 5), (138, my), 10), PAL["ink"], 3)
    elif p["mouth"] == "open":
        poly(d, [(122, my), (136, my), (129, my + 11)], fill=PAL["mouth_in"])
        line(d, [(122, my), (136, my)], PAL["ink"], 2.5)
    elif p["mouth"] == "o":
        ell(d, (122, my, 136, my + 9), outline=PAL["ink"], width=3)
    elif p["mouth"] == "frown":
        line(d, qbez((120, my + 2), (129, my - 2), (138, my + 2), 10), PAL["ink"], 3)

    # 口水（sleep：从嘴角垂落的透明水滴 + 高光，参考图关键萌点）
    if p.get("drool"):
        dx0 = hx(140)
        d0 = my + 8
        line(d, qbez((dx0, d0), (dx0 + 3, d0 + 16), (dx0 + 6, d0 + 26), 10), PAL["drool"], 4)
        ell(d, (dx0 + 2, d0 + 24, dx0 + 12, d0 + 36), fill=PAL["drool"])
        ell(d, (dx0 + 4, d0 + 27, dx0 + 7, d0 + 30), fill=(255, 255, 255, 220))


def draw_frame(state: str, frame: int, n: int) -> Image:
    global _CTX_IMG
    _CTX_IMG = new_canvas()
    d = ImageDraw.Draw(_CTX_IMG)
    p = frame_params(state, frame, n)
    draw_tail(d, p)
    draw_body(d, p)
    draw_arms(d, p)
    draw_head(d, p)
    draw_hair_front(d, p)
    draw_features(d, p)
    img = _CTX_IMG.resize((W, H), Image.LANCZOS)
    _CTX_IMG = None
    return img


def build_sheet():
    sheet = Image.new("RGBA", (W * COLS, H * len(STATES)), (0, 0, 0, 0))
    states = {}
    for row, (key, frames, dur, loop) in enumerate(STATES):
        for i in range(frames):
            frame_img = draw_frame(key, i, frames)
            sheet.paste(frame_img, (i * W, row * H))
        states[key] = {"row": row, "frames": frames, "duration": dur, "loop": loop}
    cfg = {
        "name": NAME,
        "sprite": "",
        "frame": {"w": W, "h": H, "cols": COLS},
        "states": states,
    }
    return sheet, cfg


def save_and_verify(sheet, cfg):
    dirs = []
    for root in (os.path.expanduser("~/.tokenicode/pets"), os.path.expanduser("~/.tokenicode.dev/pets")):
        d = os.path.join(root, NAME)
        os.makedirs(d, exist_ok=True)
        sheet.save(os.path.join(d, "spritesheet.webp"), lossless=True)
        with open(os.path.join(d, "pet.json"), "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
        dirs.append(d)
    assert sheet.size == (W * COLS, H * len(STATES)), f"尺寸错误 {sheet.size}"
    for row in range(len(STATES)):
        strip = sheet.crop((0, row * H, W * COLS, (row + 1) * H))
        if strip.getbbox() is None:
            raise AssertionError(f"第 {row} 行全透明（{STATES[row][0]}）")
    a = [os.path.getsize(os.path.join(d, "spritesheet.webp")) for d in dirs]
    b = [os.path.getsize(os.path.join(d, "pet.json")) for d in dirs]
    assert a[0] == a[1] and b[0] == b[1], "双目录文件不一致"
    print("✓ 已生成：")
    for d in dirs:
        print(f"  {d}/")
    for key in cfg["states"]:
        s = cfg["states"][key]
        print(f"  {key}: row {s['row']} {s['frames']}帧 {s['duration']}ms {'loop' if s['loop'] else 'once'}")
    print(f"  sheet: {sheet.size[0]}x{sheet.size[1]}")


PREVIEW_HTML = """<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>鲸鱼娘 · DeepSeek 皮肤预览</title>
<style>
  body { background:#0d1226; color:#e8ecff; font-family: system-ui,"PingFang SC","Microsoft YaHei",sans-serif; margin:0; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 24px 20px 40px; }
  h1 { font-size: 20px; margin: 0 0 4px; font-weight: 600; }
  .sub { font-size: 12px; color: #93a0c9; margin-bottom: 20px; }
  .stage { display: flex; align-items: center; gap: 28px; flex-wrap: wrap; }
  canvas#main { image-rendering: pixelated;
    background: rgba(255,255,255,.04); border-radius: 14px; border: 1px solid rgba(255,255,255,.08); }
  .info { flex: 1; min-width: 240px; }
  .state-name { font-size: 30px; font-weight: 700; margin-bottom: 4px; }
  .meta { font-size: 13px; color: #93a0c9; margin-bottom: 16px; }
  button { background: #4D6BFE; color: #fff; border: 0; padding: 9px 18px; border-radius: 9px;
    font-size: 14px; cursor: pointer; }
  button.off { background: #2a3554; }
  .hint { font-size: 12px; color: #93a0c9; margin-top: 10px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 26px; }
  .cell { background: rgba(255,255,255,.05); border: 2px solid transparent; border-radius: 12px;
    padding: 10px; cursor: pointer; text-align: center; transition: border-color .15s; }
  .cell:hover { border-color: rgba(77,107,254,.5); }
  .cell.active { border-color: #4D6BFE; background: rgba(77,107,254,.12); }
  .cell canvas { width: 96px; height: 96px; image-rendering: pixelated; display: block; margin: 0 auto; }
  .cell .label { font-size: 13px; font-weight: 600; margin-top: 8px; }
  .cell .sub { font-size: 11px; color: #93a0c9; margin-top: 2px; }
  @media (max-width: 640px) { .grid { grid-template-columns: repeat(2, 1fr); } }
</style>
</head>
<body>
<div class="wrap">
  <h1>🐋 鲸鱼娘 · DeepSeek 皮肤预览</h1>
  <div class="sub" id="sub">256×256 高清还原 · 8 状态动画 · 原创参数化绘制 · 本地文件无联网</div>
  <div class="stage">
    <canvas id="main"></canvas>
    <div class="info">
      <div class="state-name" id="curName">idle</div>
      <div class="meta" id="curMeta"></div>
      <button id="autoplay">▶ 自动轮播全部状态</button>
      <div class="hint">点击下方任一状态卡片切换主画面；轮播按引擎状态顺序循环</div>
    </div>
  </div>
  <div class="grid" id="grid"></div>
</div>
<script>
const DATA_URL = "__DATA__";
const CFG = __CFG__;
const KEYS = Object.keys(CFG.states);
const F = CFG.frame;
const MAIN_SCALE = Math.min(3, 512 / F.w);

const img = new Image();
img.src = DATA_URL;

const main = document.getElementById("main");
main.width = F.w * MAIN_SCALE;
main.height = F.h * MAIN_SCALE;
main.style.width = (F.w * MAIN_SCALE) + "px";
main.style.height = (F.h * MAIN_SCALE) + "px";
const mctx = main.getContext("2d");
mctx.imageSmoothingEnabled = false;
let cur = "idle", autoplay = false, stateStart = 0;
const counters = {};
const cells = [];

function mkCell(key, st) {
  const el = document.createElement("div");
  el.className = "cell";
  const cv = document.createElement("canvas");
  cv.width = F.w; cv.height = F.h;
  const ctx = cv.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  el.appendChild(cv);
  const lab = document.createElement("div"); lab.className = "label"; lab.textContent = key;
  const sub = document.createElement("div"); sub.className = "sub";
  sub.textContent = st.frames + "帧 · " + st.duration + "ms · " + (st.loop ? "loop" : "once");
  el.appendChild(lab); el.appendChild(sub);
  el.onclick = () => setCur(key);
  el.dataset.key = key;
  return { el, cv, ctx, key, st };
}

function advance(key, dt) {
  const st = CFG.states[key];
  const c = counters[key] || (counters[key] = { frame: 0, acc: 0 });
  c.acc += dt;
  while (c.acc >= st.duration) {
    c.acc -= st.duration;
    c.frame = st.loop ? (c.frame + 1) % st.frames : Math.min(c.frame + 1, st.frames - 1);
  }
  return c.frame;
}

function drawTo(cv, ctx, key, frame) {
  const st = CFG.states[key];
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (!img.complete || img.naturalWidth === 0) return;
  ctx.drawImage(img, frame * F.w, st.row * F.h, F.w, F.h, 0, 0, cv.width, cv.height);
}

function setCur(key) {
  cur = key; stateStart = performance.now();
  document.getElementById("curName").textContent = key;
  const st = CFG.states[key];
  document.getElementById("curMeta").textContent =
    st.frames + " 帧 / " + st.duration + " ms / " + (st.loop ? "循环播放" : "播放一次") +
    " · sheet 行 " + st.row;
  cells.forEach(c => c.el.classList.toggle("active", c.key === key));
}

const grid = document.getElementById("grid");
KEYS.forEach(k => { const c = mkCell(k, CFG.states[k]); cells.push(c); grid.appendChild(c.el); });

const btn = document.getElementById("autoplay");
btn.onclick = () => {
  autoplay = !autoplay;
  btn.textContent = autoplay ? "⏸ 停止轮播" : "▶ 自动轮播全部状态";
  btn.classList.toggle("off", autoplay);
  stateStart = performance.now();
};

let last = performance.now();
function loop(now) {
  const dt = Math.min(now - last, 200); last = now;
  drawTo(main, mctx, cur, advance(cur, dt));
  for (const c of cells) drawTo(c.cv, c.ctx, c.key, advance(c.key, dt));
  if (autoplay && now - stateStart > 2600) {
    stateStart = now;
    setCur(KEYS[(KEYS.indexOf(cur) + 1) % KEYS.length]);
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
setCur("idle");
</script>
</body>
</html>
"""


def make_preview(sheet: Image.Image, out: str):
    preview = sheet.resize((sheet.width * 2, sheet.height * 2), Image.NEAREST)
    preview.save(out)
    print(f"✓ 预览图: {out}")


def make_preview_html(sheet: Image.Image, cfg: dict, out: str):
    import base64
    import io

    buf = io.BytesIO()
    sheet.save(buf, format="WEBP", lossless=True)
    data_url = "data:image/webp;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
    html = PREVIEW_HTML.replace("__DATA__", data_url).replace(
        "__CFG__", json.dumps(cfg, ensure_ascii=False)
    )
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"✓ 预览网页: {out}")


if __name__ == "__main__":
    try:
        sheet, cfg = build_sheet()
        save_and_verify(sheet, cfg)
        script_dir = os.path.dirname(os.path.abspath(__file__))
        make_preview(sheet, os.path.join(script_dir, "preview-deepseek-whale-girl.png"))
        make_preview_html(sheet, cfg, os.path.join(script_dir, "preview-deepseek-whale-girl.html"))
    except ImportError:
        print("需要 Pillow：pip install Pillow", file=sys.stderr)
        sys.exit(1)
