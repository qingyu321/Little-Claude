# video-analysis Skill — 使用与集成说明（面向调用方 / Agent）

> 本目录是 video-analysis skill 的完整副本。**Agent 工具调用本 skill 前，先读本文件与 `SKILL.md`，再按第 4 节流程执行。**

## 0. 一句话能力

把**授权视频**（本地文件 / 公开直链 / `--allow-platform` 下的平台公开视频）转换为带时间戳、可审计的分析报告：本地解码与语音转写；远程模型**仅在用户显式选择提供者后**接收帧图像或文本证据；**原始视频流永不发送给任何模型**。

## 1. 触发条件

用户请求匹配以下任一情形时使用本 skill：

- 总结、转写、提取章节 / 关键时刻、分析一个视频
- 询问视频内容（即使只给了一个视频链接）

合法输入：本地视频文件；公开 `http(s)` 直链媒体；配合 `--allow-platform` 的 B 站 / YouTube 等平台**公开免登录**视频页面。

**必须拒绝并说明**：需要登录 / 会员（如 B 站大会员）/ 付费 / DRM / 私密 / 仅好友可见的内容；任何注入 Cookie 或绕过访问控制的请求。改为请用户提供授权原始文件或公开直链。

## 2. 环境依赖（已全部内置，免下载）

**本 skill 目录已打包全部本地依赖**，其他 agent / 其他机器直接取用，无需花费时间下载：

| 组件 | 内置位置 | 体积 | 说明 |
| --- | --- | --- | --- |
| ffmpeg + ffprobe（Gyan 8.1.2 full build） | `bin/` | ~462 MB | 脚本启动时自动加入 PATH，宿主机**没装 ffmpeg 也能直接跑** |
| faster-whisper `small` ASR 模型 | `models/faster-whisper-small/` | ~461 MB | 默认 `--asr-model small` 从该目录本地加载，**首次转写不再自动下载 ~460 MB** |
| Python 依赖离线 wheels（openai / faster-whisper / requests / yt-dlp 及传递依赖） | `wheelhouse/`（37 个 wheel，~89 MB） | — | `setup_offline.bat` 一键离线安装进 `.venv`，全程零联网 |

**一次性初始化（唯一需要执行的步骤，全程离线）：**

```bat
:: cmd 或资源管理器双击
setup_offline.bat
```

```bash
# Git Bash
./setup_offline.sh
```

脚本自动创建 `.venv` 并从 `wheelhouse/` 安装全部依赖（内置 wheels 面向 **CPython 3.11 win_amd64**；其他平台 / Python 版本改为在线安装 `python -m pip install -r requirements.txt`，国内加镜像 `-i https://pypi.tuna.tsinghua.edu.cn/simple`，ffmpeg 需另装 `winget install Gyan.FFmpeg`）。**初始化之后所有命令一律用 `.venv/Scripts/python.exe`**（或先激活虚拟环境：Git Bash `source .venv/Scripts/activate`，PowerShell `.venv\Scripts\Activate.ps1`）。

验证就绪：

```bash
.venv/Scripts/python.exe scripts/preflight.py --json
```

预期：`bundled.executables.ffmpeg / ffprobe` 指向 `bin/` 下的 exe、`bundled.asr_models` 含 `small`、`bundled.wheelhouse_wheels` > 0，且 `capabilities.offline_media_pipeline` 与 `asr` 均为 `true`。

注意：

- 唯一前置条件：Python 3.10+（64 位）。
- Windows OpenMP 运行时冲突（如 Anaconda 环境的 `libiomp5md.dll` 与 onnxruntime `vcomp140.dll`）由**子进程隔离**规避：ASR 跑在独立子进程 `scripts/asr_worker.py` 中，OpenMP 相关环境变量（`KMP_DUPLICATE_LIB_OK` 等）在进程启动前设定；即使发生原生层 abort 也只终止子进程，主管线降级为「转写失败」诚实继续，无需手工配置。
- Git Bash 中给 Windows 程序传路径要用 Windows 格式（`cygpath -w /c/...` 或 `C:\\...`）；`/c/...` 形式不会被 Windows exe 识别。

## 3. API 密钥（只能走环境变量，绝不写进命令行参数、文件或日志）

| 环境变量 | 用途 |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI 视觉 / 汇总 |
| `XAI_API_KEY` | xAI Grok 视觉 / 汇总 |
| `DEEPSEEK_API_KEY` | DeepSeek **纯文本**汇总（按设计绝不接收图片） |
| `CUSTOM_API_KEY` | 自定义 OpenAI 兼容端点（变量名可用 `--custom-api-key-env` 更改） |

设置方式：Git Bash `export CUSTOM_API_KEY="sk-..."`；PowerShell `$env:CUSTOM_API_KEY="sk-..."`。

**用户直接把 key 粘贴给你时**：内联在命令环境变量里（`CUSTOM_API_KEY="sk-..." python scripts/...`），不落盘、不回显进报告。

## 4. 标准调用流程（Agent 按此执行）

### 4.1 第零步：路由选择（优先 TOKENICODE 设置，否则询问）

**禁止**仅因无关环境变量存在就选用某个 vendor（例如 `DEEPSEEK_API_KEY` 存在 ≠ 可用 DeepSeek 看视频；DeepSeek 纯文本，**永远不能**做画面识别）。

#### TOKENICODE 默认多模态模型

用户在 **Little Claude 设置 → 视频分析** 填齐「API 端点 + 模型名称 +（API Key **或** 密钥环境变量名，二选一）」后，会话进程会注入：

| 环境变量 | 含义 |
| --- | --- |
| `TOKENICODE_VIDEO_ANALYSIS_MULTIMODAL_READY=1` | 配置完整且密钥可解析 |
| `TOKENICODE_VIDEO_ANALYSIS_BASE_URL` | OpenAI 兼容 Base URL |
| `TOKENICODE_VIDEO_ANALYSIS_API_KEY` | 解析后的密钥（直接填写或从环境变量读出） |
| `TOKENICODE_VIDEO_ANALYSIS_API_KEY_ENV` | 用户填写的环境变量**名**（若选用 env 方式） |
| `TOKENICODE_VIDEO_ANALYSIS_MODEL` | 视觉模型名 |
| `CUSTOM_API_KEY` | 同上密钥（供 `analyze_video.py` 直接读取） |
| （用户命名的 env，如 `OPENAI_API_KEY`） | 若配置了 env 名，会话内也会写入该变量，便于 `--custom-api-key-env` |

**若 `TOKENICODE_VIDEO_ANALYSIS_MULTIMODAL_READY=1`：** 默认走 **模式 B**，使用上述端点/密钥/模型；向用户简短说明将使用设置中的模型（只报模型名与端点主机，**不要**打印 key）。用户要求更换时再改。优先依赖已注入的 `CUSTOM_API_KEY`；若需显式指向用户命名的 env，可加 `--custom-api-key-env "$TOKENICODE_VIDEO_ANALYSIS_API_KEY_ENV"`。

**若未配置完整：** 必须向用户询问：

**Q1**：「是否需要使用具备视觉识别能力的模型来分析视频画面？（否则仅输出本地确定性报告：时长、关键帧时间戳、语音转写）」

- 不需要 → **模式 A**（仅本地，零远程调用、零花费）
- 需要 → 问 Q2

**Q2**：「使用哪种视觉识别方式？(1) 外置模型——请提供 OpenAI 兼容的 **API 端点**、**API Key 或密钥环境变量名**（二选一）、**模型名称**（也可先在设置中填好）；(2) 当前对话窗口正在使用的模型——由本会话的 AI 直接读取抽出的视频帧进行识别，无需任何 API key。」

- **(1) 外置模型 → 模式 B**：缺哪一项就再问哪一项，不要编造。密钥可用直接 Key **或** 环境变量名。端点须 `https://`（仅环回允许 `http://`）。可用 `GET {base}/models` 核对模型名。
- **(2) 当前会话模型 → 模式 C**：仅当本会话 AI 能看图时有效；否则说明并请用户改选。

### 4.2 预检（只读、不联网、不装东西）

```bash
.venv/Scripts/python.exe scripts/preflight.py --json
```

关键字段：`bundled.*`（内置 ffmpeg / ASR 模型 / wheelhouse 清单）；`executables.ffmpeg / ffprobe / yt_dlp`；`python_dependencies.*`；`capabilities.offline_media_pipeline / asr / platform_extraction`；`credentials.*_present`（仅布尔值，不含密钥值）。脚本会自动使用 `bin/` 内置的 ffmpeg，宿主机未装也显示为就绪。缺什么就按第 2 节告知用户（正常只需跑一次 `setup_offline.bat`），**不要自动安装**。

### 4.3 选输入模式

- 本地文件 → `--input "路径"`
- 直链媒体 → `--url "https://.../x.mp4"`
- 平台页面 → `--url "https://www.bilibili.com/video/BV.../" --allow-platform`

### 4.4 按用户选择执行

- **模式 A（本地）**：`python scripts/analyze_video.py --input/--url ... --output-dir ... --language zh`，不带任何 provider 参数。
- **模式 B（外置模型）**：本地跑 ASR（faster-whisper）+ ffmpeg 抽帧，帧发给用户端点识别。**综述默认不运行**——管线止于带时间戳的证据（`transcript.json` / `vision.json` / `timeline.json`），**由你（agent）读证据、交叉验证语音转写与视觉证据（矛盾必须如实并列呈现）后直接向用户报告**；仅无人值守、需要落盘报告文件时才显式加 `--synthesis-provider` 让管线自己生成报告。

  优先使用 TOKENICODE 已注入的环境变量（不要在命令行回显 key）：

  ```bash
  python scripts/analyze_video.py \
    --input/--url ... --output-dir ... --language zh \
    --custom-base-url "$TOKENICODE_VIDEO_ANALYSIS_BASE_URL" \
    --custom-model "$TOKENICODE_VIDEO_ANALYSIS_MODEL"
  ```

  仅当用户在对话里临时提供 key（未走设置）时再内联：

  ```bash
  CUSTOM_API_KEY="<用户提供的 key>" python scripts/analyze_video.py \
    --input/--url ... --output-dir ... --language zh \
    --custom-base-url https://端点/v1 --custom-model 模型名
  ```

  三要素齐全时**仅视觉**自动选择 custom（会在报告中披露），综述保持关闭（默认由 agent 读证据报告；显式 `--synthesis-provider` 才运行）；skill 会先用一张测试图验证模型真能看图，纯文本模型会诚实降级为本地报告。
- **模式 C（会话模型识别）**：
  1. `python scripts/analyze_video.py --input/--url ... --output-dir ... --language zh --keep-artifacts`（保留帧文件）
  2. 读 `frames.json` 与 `transcript.json`，按时间戳顺序亲自查看帧 JPEG；
  3. 交叉验证画面内容与语音转写，矛盾处带时间戳并列两种读数；
  4. 在输出目录写 `agent_report.md`（时间戳章节、关键时刻、交叉验证结论、limitations、provenance 注明视觉与汇总由会话模型完成、零外部 API 调用），**不要覆盖**管线生成的 `report.md`。

### 4.5 读结果并向用户报告

**默认流程里你就是「综述环节」**：先读证据——`timeline.json`（语音与视觉按时间窗对齐）、`vision.json`、`transcript.json`——据此用用户的语言报告：带时间戳的章节、关键时刻、声画交叉验证（矛盾处带时间戳并列两种读数，绝不私下消解）。再看 `analysis.json`（`provenance` + `limitations`，审计依据）与 `report.md`（确定性报告 + 数据流向披露；加了 `--synthesis-provider` 时含综述报告；模式 C 另有 `agent_report.md`）。
**重要：退出码 0 ≠ 完整分析成功。** 必须读 `limitations` 与 `provenance.stages.*.status`，如实告诉用户哪些模态被跳过 / 失败（`synthesis.status == "not_requested"` 是正常默认态，不是失败）。引用视频内容时带时间戳。

## 5. 命令示例

### 5.1 离线验证（无需任何 key，验证解码链路）

```bash
python scripts/analyze_video.py --input sample.mp4 --output-dir ./result/offline --skip-asr --skip-vision
```

### 5.2 本地文件 + 自定义端点（Git Bash）

```bash
CUSTOM_API_KEY="sk-..." python scripts/analyze_video.py \
  --input "C:\\videos\\demo.mp4" --output-dir ./result/demo \
  --custom-base-url https://你的端点/v1 --custom-model gpt-5.6-terra --language zh
```

PowerShell 等价写法：

```powershell
$env:CUSTOM_API_KEY="sk-..."; python scripts/analyze_video.py --input "C:\videos\demo.mp4" --output-dir .\result\demo --custom-base-url https://你的端点/v1 --custom-model gpt-5.6-terra --language zh
```

### 5.3 B 站公开视频 + 自定义端点

```bash
CUSTOM_API_KEY="sk-..." python scripts/analyze_video.py \
  --url "https://www.bilibili.com/video/BVxxxx/" --output-dir ./result/bili \
  --allow-platform --language zh --frame-interval 2 \
  --custom-base-url https://你的端点/v1 --custom-model 模型名
```

### 5.4 其他组合

```bash
# OpenAI 视觉 + DeepSeek 文本汇总
--vision-provider openai --synthesis-provider deepseek

# 公开直链 + xAI 视觉 + OpenAI 汇总
--url "https://media.example.com/x.mp4" --vision-provider xai --synthesis-provider openai
```

## 6. 输出文件契约（全部在 `--output-dir` 下）

| 文件 | 内容 |
| --- | --- |
| `media.json` | ffprobe 元数据、时长；`source.acquisition` 标明来源方式：`local_file` / `direct_media_download` / `platform_extraction` |
| `frames.json` | 关键帧时间戳与路径 |
| `transcript.json` | 带时间戳的语音分段（ASR 跳过 / 失败时为空列表） |
| `vision.json` | 提供者逐帧观察或批次错误 |
| `timeline.json` | 语音与视觉证据对齐的时间窗 |
| `analysis.json` | **首选读取**：标题、摘要、章节、关键时刻、`limitations`、逐阶段 `provenance`（provider/model/endpoint/发送的数据类别）、逐阶段耗时 `provenance.stage_durations_seconds` 与加速记录 `provenance.acceleration` |
| `report.md` | 确定性可读报告，含数据流向披露（仅显式传 `--synthesis-provider` 时含综述内容） |

未加 `--keep-artifacts` 时，临时媒体 / 音频 / 帧用后即删；用户传入的本地源文件**永不删除**。

## 7. 失败语义（Agent 必须理解）

- **提供者选择只来自第 4.1 节的用户回答**，没有任何隐式默认；环境变量里有 key 不等于授权使用。
- **各阶段独立、失败诚实披露、绝不跨供应商自动转移**：选中的提供者失败 → 只降级为本地确定性报告，绝不把帧 / 转写自动发给另一家。
- ASR 失败非致命：写空 `transcript.json` + limitation，管线继续。
- **综述默认不运行**：`provenance.stages.synthesis.status == "not_requested"` 是默认行为（agent 直接读证据报告），不是失败；仅显式 `--synthesis-provider` 时才调用综述提供者。
- 自定义模型不支持图像 → 视觉阶段中止并写入 limitations，整次运行不报废。
- 平台页面需要登录 / 会员 / DRM → 明确拒绝（`PlatformAccessRefused`），**不做任何绕过**。
- 平台抓取合并失败 → 引导用户自行下载（仅限授权途径）后以 `--input` 本地文件重跑，这是标准绕行路径。

常见错误速查：

| 症状 | 原因 / 处理 |
| --- | --- |
| `Model "xxx" is not enabled for this group` | 模型名拼写不对，或中转站未对该 key 的分组启用该模型 → 用 `GET {base}/models` 核对可用模型列表（注意 `gpt-5.6-x` 与 `gpt5.6-x` 这类连字符差异） |
| `The URL did not serve direct video media` | 给的是平台页面而非直链 → 加 `--allow-platform` |
| `Platform fetch failed: ... Stream #... copy` 等合并错误 | 本机 ffmpeg 过旧无法合并所选流 → 让用户自行下载视频后用 `--input` 本地文件模式重跑（已优先选 H.264+m4a 流以兼容旧 ffmpeg） |
| `yt-dlp is not installed` | 安装 yt-dlp（或跑一次 `setup_offline.bat`），或改用本地文件 / 直链 |
| pip 报 `UnicodeDecodeError: 'gbk' codec...` | 中文 Windows 控制台默认 GBK 所致；setup 脚本已内置 `PYTHONUTF8=1`，手工安装时加上该环境变量即可 |
| `--skip-vision is only valid together with --vision-provider none` | 两个开关互斥，去掉其一 |

## 8. 硬边界（即使用户要求也不得突破）

- 不抓取需登录的平台内容；不注入 Cookie / 凭据；不绕 DRM / 付费墙 / 地理限制；固定 `--no-playlist`，**单次仅一个视频**，无批量抓取。
- **默认仅来自 TOKENICODE 多模态设置或用户当场回答**：不得因为某个无关 API key 存在于环境变量就选用对应 provider；DeepSeek 绝不用于画面识别。
- SSRF 防护（拒绝私网 / 环回 / 元数据地址、重定向复验）不得削弱。
- API key 仅环境变量，绝不进入工件、日志或报告。
- 自定义 `--custom-base-url` 必须 `https://`（仅环回地址允许 `http://`）。
- 帧时间戳永远以管线本地生成值为准，覆盖模型返回的任何时间戳。
- 不自动安装依赖、不自动消耗提供者额度——须用户明确同意；运行外部 URL 前告知用户会下载媒体并可能消耗所选提供者的额度。

## 9. 主要参数速查

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--input` / `--url` | 二选一 | 本地文件 / 媒体链接或平台页面 |
| `--output-dir` | 必填 | 工件与报告输出目录 |
| `--allow-platform` | 关 | 平台页面抓取开关（需 yt-dlp，仅公开视频） |
| `--frame-interval` | 3 | 抽帧间隔秒数（UI 教程 1–2，谈话类 3–5） |
| `--max-duration` | 600 | 源视频时长上限（秒） |
| `--max-download-bytes` | 250 MiB | 下载大小上限 |
| `--asr-model` / `--language` | small / 自动 | Whisper 模型与语言码（`zh`、`en`…） |
| `--vision-provider` | none | 视觉提供者（自定义端点三要素齐全时自动选 custom） |
| `--synthesis-provider` | none | 综述提供者；**默认不运行**，由 agent 读证据报告，显式传入才生成管线报告（无人值守场景） |
| `--custom-base-url` / `--custom-model` / `--custom-api-key-env` | — | 自定义端点三要素 |
| `--skip-asr` / `--skip-vision` | 关 | 诚实的部分管线 |
| `--keep-artifacts` | 关 | 保留临时媒体 / 帧供审计 |
| `--segment-seconds` | 300 | 时间窗大小 |
| `--vision-batch-size` | 8 | 每个视觉请求发送的帧（拼图）数 |
| `--vision-concurrency` | 4 | 视觉批次并发数（`1` = 串行；结果恒按提交顺序返回） |
| `--accelerate` / `--no-accelerate` | 默认开 | 加速管线开关；环境变量 `TOKENICODE_VIDEO_ANALYSIS_ACCELERATE=1/0`（设置页开关注入）同样有效 |
| `--accel-cache-dir` | `~/.tokenicode/video-cache` | 加速缓存目录（仅缓存成功完成的转写 + 视觉结果） |

## 10. 测试（全部离线 / mock，不消耗 key、不联网计费）

```bash
python -m unittest discover -s tests -v
```

## 11. 目录结构

```text
video-analysis/
├── SKILL.md              # skill 元数据与工作流（agent 入口文档之一）
├── README.md             # 完整文档：能力矩阵、数据边界、参数
├── USAGE.md              # 本文件
├── requirements.txt      # Python 依赖
├── setup_offline.bat     # Windows 一键离线初始化（创建 .venv + 装依赖）
├── setup_offline.sh      # Git Bash / Linux 一键离线初始化
├── bin/                  # 内置 ffmpeg.exe + ffprobe.exe（自动加入 PATH）
├── models/
│   └── faster-whisper-small/  # 内置 ASR 模型（model.bin 等，免下载）
├── wheelhouse/           # 离线 Python wheels（CPython 3.11 win_amd64）
├── scripts/
│   ├── analyze_video.py  # 主 CLI 管线
│   ├── asr_worker.py     # ASR 子进程 worker（OpenMP 隔离，stdout 单行 JSON 契约）
│   ├── acceleration.py   # 加速管线：场景抽帧 / pHash 去重 / 2×2 拼图 / 缓存 / 双轨并行
│   ├── preflight.py      # 只读环境预检（含 bundled 清单）
│   ├── bundled_env.py    # 内置环境激活：bin/ 加入 PATH、ASR 模型路径解析
│   ├── providers.py      # 提供者适配层（OpenAI/xAI/DeepSeek/custom）
│   ├── platform_download.py  # yt-dlp 平台公开视频抓取（无登录）
│   └── safe_download.py  # SSRF 安全的直链下载器
└── tests/                # 8 个测试文件，78 个用例
```
