#!/usr/bin/env python3
"""
鲸鱼娘皮肤 v7 — 原图直用修复版（2026-08-13）

v6 事故复盘：旧 ERASE 坐标全错——把发带（原图 x320-680 y336-480）、大尾巴（x850-1100
y408-950）、右下腿脚全部误擦，基图残缺 → "头身割裂"。且 tail_swing 旋转身体、
head_move 硬切脸、眼睛/嘴画错位置。

v7 全部重做：
1. 原图 crop (150,120,1110,1020)（覆盖 deepsleep 文字/发带/头/身体/大尾巴/腿脚）
2. 原图坐标擦装饰：deepsleep (144,120,740,332) + Z z (130,326,200,392)
   （v6 的"deepsleep (240,74,320,152)""右下黑块""头顶大 Zzz"全部是误判，删除）
3. 泛洪抠白背景 → 320×300 LANCZOS（等比 1/3）→ 白边清除 → 连通域清理
4. 8 状态动画（全部整体变换，无区域切割）：
   idle 呼吸 bob / run 横移起伏 / sleep 压扁 / wave 倾斜 / jump 上跳落地
   waiting 整体旋转歪头 / review 右眼位置画睁眼+扫视 / failed 整体旋转低头
   （v6 的 tail_swing 切身体、head_move 切脸全部删除）

用法: python scripts/pets/build-original-pet.py
"""
import json
import math
import os
import sys

if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from PIL import Image, ImageDraw

SRC = r"C:\桌面\ai吊图\489a90b4c2d94db256eefdd7788394c43546384821127812.png"
W, H = 320, 300
COLS = 16  # 最大帧数（run 16 帧往返跑，其他行右侧透明补齐）
NAME = "deepseek-whale-girl"
DISPLAY = "鲸鱼娘 · DeepSeek"
ANCHOR = 292  # 锚底（内容底部 y290，压扁贴地）
ROT_CY = 180  # 旋转中心（内容垂直中心 y68-290）

# 原图 crop 与缩放
CX0, CY0, CX1, CY1 = 150, 120, 1110, 1020  # 960x900 → 等比 1/3
SX = W / (CX1 - CX0)  # 320/960 = 1/3
SY = H / (CY1 - CY0)  # 300/900 = 1/3

# 擦除区（原图坐标）：deepsleep 文字 + Z z（v6 全部误判区已删除，发带/尾巴/腿脚全保留）
ERASE_ORIG = [
    (144, 120, 740, 332),   # deepsleep 文字（发带上缘 y336，留 4px 缓冲）
    (130, 326, 200, 392),   # Z z（左上，独立于发带 x320+）
]

# 眼睛位置（基图坐标）：趴睡侧脸只露出一只眼（原图 x544-566 y696-710 闭眼弧线）
# 基图 = (原图-150)/3, (原图-120)/3 → x131-139 y192-197，画 r=8 圆眼覆盖
REVIEW_EYE = ((131, 188), (147, 204))  # 画眼区域（r=8 天蓝圆眼 + 瞳孔扫视）
EYE_CENTER = (139, 196)


def to_base(x, y):
    return ((x - CX0) * SX, (y - CY0) * SY)


def build_base():
    """从原图重建基图：crop → 擦装饰（原图坐标）→ 泛洪抠白 → 缩放 → 白边/连通域清理。"""
    img = Image.open(SRC).convert("RGBA")
    img = img.crop((CX0, CY0, CX1, CY1))
    px = img.load()
    for (x0, y0, x1, y1) in ERASE_ORIG:
        # 裁剪到 crop 范围内
        x0 = max(x0, CX0)
        x1 = min(x1, CX1)
        y0 = max(y0, CY0)
        y1 = min(y1, CY1)
        for y in range(y0, y1):
            for x in range(x0, x1):
                px[x - CX0, y - CY0] = (0, 0, 0, 0)
    # 泛洪抠白背景（四边 BFS，颜色距离 < 50）
    img = flood_cut(img)
    # 等比缩放
    img = img.resize((W, H), Image.LANCZOS)
    img = clean_edges(img)
    img = remove_islands(img)
    return img


def flood_cut(img):
    """四边泛洪抠背景（纯白）。"""
    bw, bh = img.size
    px = img.load()
    visited = bytearray(bw * bh)
    stack = []
    for x in range(bw):
        stack.append((x, 0))
        stack.append((x, bh - 1))
    for y in range(bh):
        stack.append((0, y))
        stack.append((bw - 1, y))
    while stack:
        x, y = stack.pop()
        if x < 0 or y < 0 or x >= bw or y >= bh:
            continue
        i = y * bw + x
        if visited[i]:
            continue
        r, g, b, a = px[x, y]
        if a > 0 and r > 240 and g > 240 and b > 235:
            visited[i] = 1
            px[x, y] = (0, 0, 0, 0)
            stack.extend(((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)))
    return img


def clean_edges(img):
    """白边清除：近白 + 半透明边缘像素置透明（防透明背景白边）；alpha<110 删除。"""
    out = img.copy()
    px = out.load()
    for y in range(H):
        for x in range(W):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            if a < 110:
                px[x, y] = (0, 0, 0, 0)
            elif r > 225 and g > 225 and b > 220:
                # 近白半透明 = 背景白混入边缘（白褶边/发丝边缘）→ 全删防白边
                if a < 200:
                    px[x, y] = (0, 0, 0, 0)
    return out


def remove_islands(img, min_size=1500):
    """连通域 BFS：擦除与主体不相连的小块（残留文字/碎片自动清除）。"""
    out = img.copy()
    px = out.load()
    visited = bytearray(W * H)
    comps = []
    for start in range(W * H):
        if visited[start]:
            continue
        sx, sy = start % W, start // W
        if px[sx, sy][3] < 128:
            continue
        stack = [start]
        visited[start] = 1
        pts = []
        while stack:
            i = stack.pop()
            pts.append(i)
            x, y = i % W, i // W
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= nx < W and 0 <= ny < H:
                    j = ny * W + nx
                    if not visited[j] and px[nx, ny][3] >= 128:
                        visited[j] = 1
                        stack.append(j)
        comps.append(pts)
    main = max(comps, key=len) if comps else []
    removed = 0
    for pts in comps:
        if len(pts) < min_size:
            removed += len(pts)
            for i in pts:
                px[i % W, i // W] = (0, 0, 0, 0)
    print(f"  连通域: {len(comps)} 个，主体 {len(main)}px，擦除小块 {removed}px")
    return out


STATES = [
    ("idle",    8, 150, True),
    ("run",    16, 240, True),
    ("sleep",   4, 600, True),
    ("wave",    4, 150, False),
    ("jump",    6, 130, False),
    ("waiting", 4, 160, True),
    ("review",  4, 200, True),
    ("failed",  4, 200, False),
]


def paint_open_eye(img, scan=0):
    """review：在右眼闭眼线位置画睁眼（天蓝圆眼 + 瞳孔 + 高光，瞳孔随 scan 扫视）。"""
    out = img.copy()
    d = ImageDraw.Draw(out)
    x0, y0 = REVIEW_EYE[0]
    x1, y1 = REVIEW_EYE[1]
    cx, cy = (x0 + x1) / 2 + scan, (y0 + y1) / 2
    r = (x1 - x0) / 2
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(255, 255, 255, 255))
    d.ellipse((cx - r * 0.85, cy - r * 0.85, cx + r * 0.85, cy + r * 0.85),
              fill=(110, 185, 245, 255))
    d.polygon([(cx - r * 0.38, cy - r * 0.1), (cx + r * 0.38, cy - r * 0.1),
               (cx + r * 0.38, cy + r * 0.8), (cx - r * 0.38, cy + r * 0.8)],
              fill=(28, 38, 66, 255))
    d.ellipse((cx - 3.5, cy - 5.5, cx + 1, cy - 1), fill=(255, 255, 255, 250))
    d.ellipse((cx + 2, cy + 2, cx + 4.5, cy + 4.5), fill=(255, 255, 255, 240))
    return out


def transform(img, dx=0, dy=0, scale_x=1.0, scale_y=1.0, angle=0.0):
    """几何变换（平移/锚底缩放/旋转）。旋转用 expand 画布再裁回，不切角色边缘。
    注意：Pillow AFFINE 矩阵是【逆映射】（输出坐标 → 输入坐标），
    正变换 x' = scale_x*x + dx, y' = scale_y*y + dy + ANCHOR*(1-scale_y) 的矩阵为
    (1/sx, 0, -dx/sx, 0, 1/sy, -(dy + ANCHOR*(1-scale_y))/sy)。
    写反会让压扁变拉伸（jump 落地帧拉长 bug）。"""
    if dx == 0 and dy == 0 and scale_x == 1.0 and scale_y == 1.0 and angle == 0.0:
        return img.copy()
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    inv_sx = 1.0 / scale_x
    inv_sy = 1.0 / scale_y
    t = img.transform((W, H), Image.AFFINE,
                      (inv_sx, 0, -dx * inv_sx, 0, inv_sy,
                       -(dy + ANCHOR * (1 - scale_y)) * inv_sy),
                      resample=Image.BICUBIC)
    if angle:
        t = t.rotate(angle, resample=Image.BILINEAR, center=(W / 2, ROT_CY), expand=True)
        # 裁回原尺寸（旋转画布中心）
        tw, th = t.size
        t = t.crop(((tw - W) // 2, (th - H) // 2, (tw - W) // 2 + W, (th - H) // 2 + H))
    out.paste(t, (0, 0), t)
    return out


def frame_transform(state, frame, n):
    if state == "idle":
        return {"dy": -abs(math.sin((frame / 8) * math.pi * 2)) * 4}
    if state == "run":
        # 往返跑：16 帧 = 8 帧去程 + 8 帧返程。角色缩小 0.75 后在画布内
        # 从左跑到右（dx 0→87，全程完整不出框，右缘 87+233=320）
        i = frame % 8
        dx = i * (87 / 7)
        if frame >= 8:
            dx = 87 - i * (87 / 7)
        return {"dx": dx, "dy": -abs(math.sin((i / 7) * math.pi)) * 10,
                "scale_x": 0.75, "scale_y": 0.75}
    if state == "sleep":
        return {"dy": (0, -4, -8, -4)[frame], "scale_y": 0.93}
    if state == "wave":
        return {"dy": -4, "angle": math.sin((frame / (n - 1)) * math.pi * 2) * 6}
    if state == "jump":
        arc = math.sin((frame / (n - 1)) * math.pi)
        if frame == n - 1:
            return {"scale_y": 0.78}
        return {"dy": -arc * 24, "scale_y": 0.97}
    if state == "waiting":
        # 整体旋转歪头（绕头部中心），无区域切割
        return {"dy": (0, -3, 0, -3)[frame], "angle": math.sin((frame / (n - 1)) * math.pi * 2) * 4}
    if state == "review":
        # 不画睁眼（用户反馈悬浮感）——纯整体微动，审查感由引擎氛围层扫描线提供
        return {"dy": (0, -2, 0, -2)[frame], "angle": math.sin((frame / (n - 1)) * math.pi * 2) * 2}
    if state == "failed":
        # 低头：整体旋转 -3°（绕头颈），无撇嘴（原图趴睡无可见嘴）
        return {"dy": (0, -2, -3, -2)[frame], "angle": -3}
    return {}


def build_sheet():
    base = build_base()
    sheet = Image.new("RGBA", (W * COLS, H * len(STATES)), (0, 0, 0, 0))
    states = {}
    for row, (key, frames, dur, loop) in enumerate(STATES):
        for i in range(frames):
            p = frame_transform(key, i, frames)
            src = base
            f = transform(src, dx=p.get("dx", 0), dy=p.get("dy", 0),
                          scale_x=p.get("scale_x", 1.0), scale_y=p.get("scale_y", 1.0),
                          angle=p.get("angle", 0.0))
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


PREVIEW_HTML = """<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>鲸鱼娘 · DeepSeek 皮肤预览</title>
<style>
  body { background:#0d1226; color:#e8ecff; font-family: system-ui,"PingFang SC","Microsoft YaHei",sans-serif; margin:0; }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 24px 20px 40px; }
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
  .cell canvas { width: 128px; height: 120px; image-rendering: pixelated; display: block; margin: 0 auto; }
  .cell .label { font-size: 13px; font-weight: 600; margin-top: 8px; }
  .cell .sub { font-size: 11px; color: #93a0c9; margin-top: 2px; }
  @media (max-width: 640px) { .grid { grid-template-columns: repeat(2, 1fr); } }
</style>
</head>
<body>
<div class="wrap">
  <h1>🐋 鲸鱼娘 · DeepSeek 皮肤预览</h1>
  <div class="sub">320×300 原图直用 v7 · 8 状态动画 · 本地文件无联网</div>
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
const MAIN_SCALE = Math.min(2.2, 600 / F.w);

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
    sheet, cfg = build_sheet()
    save_and_verify(sheet, cfg)
    script_dir = os.path.dirname(os.path.abspath(__file__))
    make_preview_html(sheet, cfg, os.path.join(script_dir, "preview-deepseek-whale-girl.html"))
    # 调试图
    base = sheet.crop((0, 0, W, H))
    base.save(os.path.join(script_dir, "_v7_idle0.png"))
    rows = {"run": 1, "sleep": 2, "wave": 3, "jump": 4, "waiting": 5, "review": 6, "failed": 7}
    keys = [("idle", 0)] + [(k, 2 if k == "jump" else 1) for k in rows]
    grid = Image.new("RGBA", (W * 3, H * 3), (255, 255, 255, 255))
    for i, (k, f) in enumerate(keys):
        r, c = divmod(i, 3)
        fr = sheet.crop((f * W, rows.get(k, 0) * H, (f + 1) * W, (rows.get(k, 0) + 1) * H))
        grid.paste(fr, (c * W, r * H))
    grid.save(os.path.join(script_dir, "_v7_grid.png"))
    print("✓ 调试图: _v7_idle0.png / _v7_grid.png")
