#!/usr/bin/env python3
"""
参考图像素化皮肤管线：img1（正面疑惑女仆）→ 160×160 像素画 → 8 状态衍生。
1. 擦除装饰残留（左上/右上问号、右下杂块、底部蓝块、"区"字牌残迹）
2. 主体自动居中
3. idle 用主体；其余 7 状态几何衍生（平移/压扁/闭眼/倾动）
4. 拼 sheet 1280×1280 + pet.json（frame 160×160）→ 双目录落盘
用法: python build-ref-pet.py
"""
import json
import math
import os
import sys

if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from PIL import Image, ImageDraw

TARGET = 160
W = H = TARGET
COLS = 8
NAME = "deepseek-whale-girl"
DISPLAY = "鲸鱼娘 · DeepSeek"

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_px_img1_160.png")

# 装饰擦除区域（像素坐标，来自字符画定位）：(x0,y0,x1,y1)
ERASE = [
    (0, 0, 66, 52),      # 左上：白色问号气泡（主体实测在 x38-62 y0-50）
    (82, 2, 112, 26),    # 右上：蓝色问号
    (146, 114, 160, 152),  # 右下：杂块
    (100, 150, 140, 160),  # 底部：蓝色杂块（实测残留 x104-138）
    (30, 80, 126, 102),  # 手持白牌子 + 手残影（实测残留到 x32）
    (116, 100, 160, 160),  # 旧小尾巴区域（替换用）
    (150, 150, 160, 160),  # 右下角残点
]

# 补画元素（居中前按 160 坐标；补画在 load_clean 返回后执行）
def paint_extras(img):
    """补画：胸前两只小手 + 头顶两侧鲸鱼鳍发束 + 尾巴描边强化。"""
    out = img.copy()
    d = ImageDraw.Draw(out)
    # 两只小手（肤色圆，身体两侧：主体中心 x96）
    for cx in (76, 116):
        d.ellipse((cx - 4, 86, cx + 4, 94), fill=(253, 230, 220, 255))
    # 头顶两侧鲸鱼鳍发束（三角鳍：深蓝 + 浅蓝高光，加大更醒目）
    for cx in (68, 100):
        d.polygon([(cx - 4, 20), (cx + 10, 6), (cx + 12, 22)], fill=(70, 100, 180, 255))
        d.polygon([(cx - 1, 18), (cx + 6, 10), (cx + 8, 19)], fill=(120, 175, 235, 255))
    # 大鲸鱼尾（替换原小尾：尾柄 + 双瓣尾鳍 + 白腹 + 白描边，放大版）
    d.polygon([(108, 128), (122, 112), (144, 92), (154, 100), (140, 116), (122, 130)], fill=(46, 76, 145, 255))
    d.polygon([(122, 130), (140, 124), (158, 142), (148, 154), (128, 140)], fill=(46, 76, 145, 255))
    d.polygon([(108, 128), (122, 118), (136, 126), (122, 132)], fill=(240, 248, 255, 255))  # 白腹
    d.line((144, 92, 154, 100), fill=(255, 255, 255, 255), width=2)
    d.line((158, 142, 148, 154), fill=(255, 255, 255, 255), width=2)
    d.line((144, 92, 154, 100), fill=(120, 175, 235, 255), width=1)
    # 围裙迷你蓝鲸鱼徽章（参考图：围裙中央小鲸鱼图案）
    d.ellipse((86, 104, 96, 113), fill=(110, 170, 235, 255))
    d.polygon([(95, 106), (100, 103), (99, 109)], fill=(110, 170, 235, 255))
    d.ellipse((88.5, 107, 91, 109.5), fill=(255, 255, 255, 240))
    return out

# 8 状态：key, frames, duration_ms, loop
STATES = [
    ("idle", 8, 150, True),
    ("run", 8, 120, True),
    ("sleep", 4, 600, True),
    ("wave", 4, 150, False),
    ("jump", 6, 130, False),
    ("waiting", 4, 160, True),
    ("review", 4, 200, True),
    ("failed", 4, 200, False),
]


def load_clean():
    """读取像素化图 → 擦除装饰 → 主体居中 → 160×160。"""
    img = Image.open(SRC).convert("RGBA")
    px = img.load()
    for (x0, y0, x1, y1) in ERASE:
        for y in range(y0, y1):
            for x in range(x0, x1):
                px[x, y] = (0, 0, 0, 0)
    # 主体 bbox → 内容裁剪 → 画布正中央（此前 bug：bbox 偏左上导致居中失效）
    bbox = img.getbbox()
    if not bbox:
        raise SystemExit("主体全空")
    content = img.crop(bbox)
    bw, bh = content.size
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    cx, cy = (W - bw) // 2, (H - bh) // 2
    canvas.paste(content, (cx, cy))
    print(f"主体 bbox {bbox} ({bw}x{bh}) 居中偏移 ({cx},{cy})")
    # 边缘半透明清理（alpha<100 删除，去轮廓杂色）
    px = canvas.load()
    for y in range(H):
        for x in range(W):
            r, g, b, a = px[x, y]
            if 0 < a < 100:
                px[x, y] = (0, 0, 0, 0)
    return paint_extras(canvas)


def transform(img, dx=0, dy=0, scale_y=1.0, scale_x=1.0, angle=0.0, anchor_y=H - 8):
    """几何变换（纯平移 / 锚底缩放 / 微旋转），返回新图。"""
    if dx == 0 and dy == 0 and scale_y == 1.0 and scale_x == 1.0 and angle == 0.0:
        return img.copy()
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    img = img.transform(
        (W, H), Image.AFFINE,
        (scale_x, 0, dx, 0, scale_y, dy - anchor_y * (1 - scale_y)),
        resample=Image.NEAREST,
    )
    if angle:
        img = img.rotate(angle, resample=Image.NEAREST, center=(W / 2, anchor_y))
    out.paste(img, (0, 0), img)
    return out


def paint_eyes_closed(img):
    """眼睛区域涂闭眼线（深色横线）。眼睛位置：字符画定位 x66-82 / x88-104, y60-70。
    必须在几何变换前调用（变换会移动眼睛位置）。"""
    out = img.copy()
    d = ImageDraw.Draw(out)
    for cx in (74, 96):
        d.line((cx - 7, 66, cx + 7, 66), fill=(24, 38, 66, 255), width=3)
    return out


def paint_wave_arm(img):
    """wave：右侧画抬起的手臂（肤色条 + 手），从肩 x122,y86 抬到 x142,y58。"""
    out = img.copy()
    d = ImageDraw.Draw(out)
    pts = [(122, 84), (130, 74), (138, 64), (142, 56)]
    d.line(pts, fill=(253, 230, 220, 255), width=6)
    d.line(pts, fill=(230, 200, 175, 255), width=2)
    d.ellipse((137, 50, 147, 62), fill=(253, 230, 220, 255))
    return out


def paint_scan_eyes(img, scan):
    """review：瞳孔扫视——在眼睛白底上画深蓝瞳孔小块，位置随 scan 左右移。"""
    out = img.copy()
    d = ImageDraw.Draw(out)
    for cx in (74, 96):
        d.ellipse((cx - 5, 62, cx + 5, 70), fill=(255, 255, 255, 255))      # 白底
        d.ellipse((cx + scan - 2, 64, cx + scan + 2, 68), fill=(30, 60, 130, 255))  # 深蓝瞳孔
    return out


def split_upper(img, shift):
    """上半身（y<85）x 平移 shift 模拟前倾。"""
    if shift == 0:
        return img.copy()
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    upper = img.crop((0, 0, W, 85))
    rest = img.crop((0, 85, W, H))
    out.paste(upper, (shift, 0))
    out.paste(rest, (0, 85))
    return out


def head_tilt(img, shift):
    """头部区域（y<92）x 平移 shift 模拟歪头。"""
    if shift == 0:
        return img.copy()
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    head = img.crop((0, 0, W, 92))
    rest = img.crop((0, 92, W, H))
    out.paste(head, (shift, 0))
    out.paste(rest, (0, 92))
    return out


def frame_params(state, frame, n):
    """每帧几何参数：dx/dy/scale_y/angle/闭眼/抬手。"""
    if state == "idle":
        return {"dy": -abs(math.sin((frame / 8) * math.pi * 2)) * 3}
    if state == "run":
        b = -abs(math.sin((frame / 8) * math.pi * 2)) * 6   # 弹跳加大
        leg = 5 if frame % 2 else -5                         # 腿部交替加大
        return {"dy": b, "leg": leg, "lean": 4}              # 上半身前倾 4px
    if state == "sleep":
        return {"scale_y": 0.88, "dy": (0, -1, -2, -1)[frame], "eyes": "closed"}
    if state == "wave":
        return {"dx": math.sin((frame / (n - 1)) * math.pi * 2) * 3,
                "dy": -2, "arm": "wave"}
    if state == "jump":
        arc = math.sin((frame / (n - 1)) * math.pi)
        if frame == n - 1:
            return {"scale_y": 0.78, "dy": 0}  # 落地压扁（明显）
        return {"dy": -arc * 24, "scale_y": 0.96}  # 上跳 24px
    if state == "waiting":
        return {"dx": math.sin((frame / 2) * math.pi) * 3, "dy": (0, -2, 0, -2)[frame],
                "tilt": 4}  # 歪头 4px
    if state == "review":
        return {"dy": (0, -1, 0, -1)[frame], "scan": 3 if frame % 2 else -3}
    if state == "failed":
        return {"dy": (0, -1, -2, -1)[frame], "head_dy": 3 + (0, 1, 2, 1)[frame]}
    return {}


def split_legs(img, shift):
    """下半身（y>H*0.72）x 平移 shift 模拟跑步抬腿。"""
    if shift == 0:
        return img.copy()
    out = img.copy()
    upper = img.crop((0, 0, W, int(H * 0.72)))
    lower = img.crop((0, int(H * 0.72), W, H))
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    out.paste(upper, (0, 0))
    out.paste(lower, (shift, int(H * 0.72)))
    return out


def head_lower(img, dy):
    """failed：头部区域（上半部分）整体下移，产生低头感。"""
    if dy == 0:
        return img.copy()
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    head = img.crop((0, 0, W, int(H * 0.55)))
    rest = img.crop((0, int(H * 0.55), W, H))
    out.paste(head, (0, dy))
    out.paste(rest, (0, int(H * 0.55)))
    return out


def build_sheet():
    base = load_clean()
    sheet = Image.new("RGBA", (W * COLS, H * len(STATES)), (0, 0, 0, 0))
    states = {}
    for row, (key, frames, dur, loop) in enumerate(STATES):
        for i in range(frames):
            p = frame_params(key, i, frames)
            src = base
            if p.get("eyes") == "closed":
                src = paint_eyes_closed(src)   # 闭眼必须先于几何变换（眼睛会移动）
            if p.get("arm") == "wave":
                src = paint_wave_arm(src)
            if p.get("scan"):
                src = paint_scan_eyes(src, p["scan"])
            f = transform(src, dx=p.get("dx", 0), dy=p.get("dy", 0),
                          scale_y=p.get("scale_y", 1.0), scale_x=p.get("scale_x", 1.0),
                          angle=p.get("angle", 0.0))
            if p.get("leg"):
                f = split_legs(f, p["leg"])
            if p.get("lean"):
                f = split_upper(f, p["lean"])
            if p.get("tilt"):
                f = head_tilt(f, p["tilt"])
            if p.get("head_dy"):
                f = head_lower(f, p["head_dy"])
            sheet.paste(f, (i * W, row * H))
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
    # 调色板统计
    counts = {}
    px = sheet.load()
    for y in range(0, sheet.height, 4):
        for x in range(0, sheet.width, 4):
            r, g, b, a = px[x, y]
            if a < 128:
                continue
            k = (r, g, b)
            counts[k] = counts.get(k, 0) + 1
    print("调色板（前 14 色）:")
    for k, c in sorted(counts.items(), key=lambda kv: -kv[1])[:14]:
        print(f"  #{k[0]:02X}{k[1]:02X}{k[2]:02X}  {c}px")


if __name__ == "__main__":
    sheet, cfg = build_sheet()
    save_and_verify(sheet, cfg)
    script_dir = os.path.dirname(os.path.abspath(__file__))
    # 预览图（idle 帧 4x）
    idle = sheet.crop((0, 0, W, H)).resize((W * 4, H * 4), Image.NEAREST)
    idle.save(os.path.join(script_dir, "_ref_idle0_4x.png"))
    sheet.resize((sheet.width * 2, sheet.height * 2), Image.NEAREST).save(
        os.path.join(script_dir, "_ref_sheet_2x.png"))
    print("✓ 调试图: _ref_idle0_4x.png / _ref_sheet_2x.png")
