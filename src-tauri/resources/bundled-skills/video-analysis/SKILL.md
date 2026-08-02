---
name: video-analysis
description: Analyze authorized video content from a local video file, a public direct HTTP(S) video URL, or—with --allow-platform—a single public video on a platform page (e.g. Bilibili/YouTube watch links, fetched via yt-dlp without login or cookies). Use this skill whenever the user asks to read, understand, summarize, transcribe, extract chapters or key moments from a video, or asks questions about a video's contents—even if they refer to a video link rather than saying "video analysis." If TOKENICODE has a complete default multimodal model (env TOKENICODE_VIDEO_ANALYSIS_MULTIMODAL_READY=1 with base URL, API key, model), use that external vision endpoint by default; otherwise ask the user for API endpoint, API key, and model name (or whether to use the current chat session model / local-only). It safely downloads direct media links, extracts audio and key frames, transcribes speech, interprets frames through the selected route, cross-checks speech and visual evidence, and produces timestamped results.
---

# Video Analysis

Use this skill to turn an authorized video file or direct video URL into a timestamped, auditable report. Remote models do not receive the raw MP4/WebM stream. This workflow decodes the video locally, extracts timestamped JPEG frames and speech transcription, and—only after the user answers the mandatory pre-run interview—interprets frames through the route the user chose.

## Authorized inputs only

Accept any of:

- A local video file that the user is authorized to analyze.
- A public, direct `http://` or `https://` media URL, such as a public `.mp4` or `.webm` resource.
- With `--allow-platform`, a public video-platform page (for example a Bilibili or YouTube watch link). The skill fetches the single public video with `yt-dlp` and then processes it locally.

Platform-page fetching is deliberately narrow and these limits are not to be weakened:

- Public, anonymously accessible videos only. Never send cookies, passwords, or authenticated headers; never log in; never access member-only, private, friend-only, or age-gated content.
- No DRM circumvention. DRM-protected streams are refused with an honest error, not decrypted.
- Single video per run (`--no-playlist`); no batch scraping, playlists, or channels.
- The user remains responsible for the platform's terms of service and for being authorized to analyze the content.

If a platform video requires login or membership, do not work around it: ask the user for an authorized original file, a direct public export, or the platform's official API/export route. The same applies when a platform fetch fails on stream merging/postprocessing: the authorized fallback is a local file the user downloaded themselves, re-run with `--input` — never a credential, format, or access-control workaround.

The URL fetcher blocks local, private, link-local, reserved, and metadata-service addresses. Do not weaken these checks.

## Workflow

### Step 0 — Pre-run route selection (TOKENICODE defaults first)

Before executing ANY analysis, decide the vision route. **Never pick a random vendor just because an unrelated key is in the environment** (e.g. `DEEPSEEK_API_KEY` present ≠ permission to use DeepSeek for vision — DeepSeek is text-only). Prefer the **TOKENICODE app defaults** when they are complete.

#### TOKENICODE default multimodal model (Mode B shortcut)

TOKENICODE / Little Claude can inject these environment variables into the Claude session when the user saved **Settings → 视频分析**. Completeness requires **endpoint + model + (API Key OR key env-var name)**.

| Env var | Meaning |
| --- | --- |
| `TOKENICODE_VIDEO_ANALYSIS_MULTIMODAL_READY=1` | Defaults are complete and the secret was resolvable |
| `TOKENICODE_VIDEO_ANALYSIS_BASE_URL` | OpenAI-compatible base URL |
| `TOKENICODE_VIDEO_ANALYSIS_API_KEY` | Resolved secret (from direct key or named env var); also mirrored as `CUSTOM_API_KEY` |
| `TOKENICODE_VIDEO_ANALYSIS_API_KEY_ENV` | Optional: env-var **name** the user configured instead of pasting a key |
| `TOKENICODE_VIDEO_ANALYSIS_MODEL` | Vision-capable model name |
| `CUSTOM_API_KEY` | Same resolved secret, for `analyze_video.py` Mode B |
| *(named env, e.g. `OPENAI_API_KEY`)* | When the user set an env-var name, that name is also populated in the session so `--custom-api-key-env` works |

**If `TOKENICODE_VIDEO_ANALYSIS_MULTIMODAL_READY=1` and base URL / model / resolved key are non-empty:**

1. Briefly tell the user (in their language) that the app's default multimodal model will be used, naming the **model** and **endpoint host only** (never print the API key or dump the env-var value).
2. Proceed with **Mode B** using those values — do **not** re-ask for API endpoint / key / model name unless the user asks to change them or the run fails with auth/model errors. Synthesis is off by default: read the evidence and report directly (Step 4).
3. Prefer `CUSTOM_API_KEY` (already injected). If only `TOKENICODE_VIDEO_ANALYSIS_API_KEY_ENV` is set and you need to point the script at that name, pass `--custom-api-key-env "$TOKENICODE_VIDEO_ANALYSIS_API_KEY_ENV"`.
4. Optional one-line confirmation is fine (e.g. 「将使用设置中的多模态模型 `…`，如需更换请说明」); if the user rejects, fall through to the interview below.

**If the defaults are missing or incomplete** (`TOKENICODE_VIDEO_ANALYSIS_MULTIMODAL_READY` unset/empty, or base URL / model empty, or neither direct key nor resolvable env-var secret):

Ask the user the questions below and let their answers decide the route.

Present the questions in the user's language. Chinese wording:

**Q1.** 「是否需要使用具备视觉识别能力的模型来分析视频画面？（否则仅输出本地确定性报告：时长、关键帧时间戳、语音转写）」

- **No** → Mode A (local-only).
- **Yes** → ask Q2.

**Q2.** 「使用哪种视觉识别方式？(1) 外置模型——请提供 OpenAI 兼容的 **API 端点 (Base URL)**、**API Key 或密钥环境变量名**、**模型名称**（可在设置 → 视频分析 中预先填写，Key 与环境变量二选一即可；填齐后下次将自动使用）；(2) 当前对话窗口正在使用的模型——由我（本会话的 AI）直接读取抽出的视频帧进行识别，无需任何 API key。」

- **(1) External model** → Mode B. Collect: endpoint base URL (must be `https://`, or `http://` only for loopback), model name, and **either** an API key **or** the name of an env var that holds the key. If any required piece is missing, **ask again for the missing field(s)** — do not invent defaults. If the model name may be wrong (relays often enable specific IDs), verify it against `GET {base}/models` first.
- **(2) Current session model** → Mode C. Only valid if the agent running this skill is itself multimodal (can view images). If the current session model cannot see images, say so and re-ask Q2.

### Step 1 — Preflight

```bash
python "$HOME/.claude/skills/video-analysis/scripts/preflight.py" --json
```

On Windows, `$HOME` may expand to a wrong drive in some shells (e.g. Git Bash mapping it to `D:\...`); if the file is not found, verify the path exists and use the absolute path, e.g. `python "C:/Users/<user>/.claude/skills/video-analysis/scripts/preflight.py" --json`. If the skill's one-time offline setup (`setup_offline.bat` / `setup_offline.sh`) was run, use `.venv/Scripts/python.exe` instead of `python`.

The report's `bundled` block inventories the resources shipped with the skill: `bundled.executables.ffmpeg/ffprobe` (from `bin/`), `bundled.asr_models` (from `models/`), and `bundled.wheelhouse_wheels`. The scripts prepend `bin/` to `PATH` themselves, so `executables.ffmpeg` resolves even when the host has no system ffmpeg.

### Step 2 — Prerequisites

**The skill body (Python scripts) is bundled with the app. Heavy dependencies — `bin/` (ffmpeg + ffprobe), `models/faster-whisper-small/` (the default ASR model), and `wheelhouse/` (offline Python wheels) — are downloaded once via the runtime installer (Settings → 视频分析 or the Skills page prompt).** Once installed, the scripts use the bundled ffmpeg/ffprobe and ASR model automatically. Explain missing prerequisites instead of silently installing packages or adding secrets:

- If preflight reports missing Python packages, the user runs the one-time offline setup once: `setup_offline.bat` (or `setup_offline.sh` in Git Bash), which installs everything from `wheelhouse/` into a `.venv` with no network; subsequent commands use `.venv/Scripts/python.exe`.
- Only if a bundled resource is actually missing, suggest the online fallback: ffmpeg via `winget install Gyan.FFmpeg` (then reopen the terminal), packages via `pip install -r requirements.txt`, and the ASR model auto-downloads on first transcription when not bundled.
- Mode B additionally requires the user-supplied key; platform-page fetching with `--allow-platform` uses the bundled `yt-dlp` from the wheelhouse install.

### Step 3 — Run the selected mode

#### Mode A — Local-only (user declined vision)

```bash
python scripts/analyze_video.py \
  --input "C:\\videos\\demo.mp4" \
  --output-dir "./video-results/demo" \
  --language zh
```

No remote calls, no API key, no cost. The report honestly states that visual meaning was not interpreted.

#### Mode B — External model (user supplied key + endpoint + model name)

Run ASR (`faster-whisper`) and `ffmpeg` frame extraction locally and send frames to the user's endpoint. The pipeline stops at **timestamped evidence** (`transcript.json` / `vision.json` / `timeline.json`): **synthesis is not run by default** — you (the agent running this skill) read the evidence, **cross-validate the ASR transcript against the visual observations** (contradictions between what is said and what is shown must be surfaced, not silently resolved), and report to the user with timestamps. Only when a standalone report file is needed without an agent present (headless/automated use) add `--synthesis-provider` to have the pipeline generate the report itself.

**Prefer TOKENICODE defaults when available** (see Step 0). When `TOKENICODE_VIDEO_ANALYSIS_*` / `CUSTOM_API_KEY` are already in the process environment, pass only the URL and model on the command line and **do not** re-print the key:

```bash
# TOKENICODE already injected CUSTOM_API_KEY + TOKENICODE_VIDEO_ANALYSIS_* into this session
python scripts/analyze_video.py \
  --input "C:\\videos\\demo.mp4" \
  --output-dir "./video-results/demo" \
  --language zh \
  --custom-base-url "$TOKENICODE_VIDEO_ANALYSIS_BASE_URL" \
  --custom-model "$TOKENICODE_VIDEO_ANALYSIS_MODEL"
```

On Windows PowerShell (env vars from the TOKENICODE session):

```powershell
python scripts/analyze_video.py `
  --input "C:\videos\demo.mp4" `
  --output-dir ".\video-results\demo" `
  --language zh `
  --custom-base-url $env:TOKENICODE_VIDEO_ANALYSIS_BASE_URL `
  --custom-model $env:TOKENICODE_VIDEO_ANALYSIS_MODEL
```

If the user pastes a key only in chat (no app settings), set it inline on the command — never persist it, never echo it into the report or chat:

```bash
CUSTOM_API_KEY="<key the user supplied>" python scripts/analyze_video.py \
  --input "C:\\videos\\demo.mp4" \
  --output-dir "./video-results/demo" \
  --language zh \
  --custom-base-url https://api.relay.example/v1 \
  --custom-model gpt-5.6-terra
```

With the key set plus `--custom-base-url` and `--custom-model`, the custom provider is auto-selected for the **vision stage only** (disclosed in limitations and provenance); synthesis stays off by default — the agent running this skill reads the evidence and reports directly, and `--synthesis-provider` opts the pipeline report in for headless use. The pipeline verifies image input with a single test image before sending frame batches; a text-only model degrades to an honest local report instead of failing. In PowerShell use `$env:CUSTOM_API_KEY="<key>"; python scripts\analyze_video.py ...`. Use `--custom-api-key-env OTHER_VAR` if the key already lives in another variable. To use different models per stage, spell them out with `--vision-provider custom --vision-model <name> --synthesis-provider custom --synthesis-model <name>`.

For an authorized direct media URL:

```bash
python scripts/analyze_video.py \
  --url "https://media.example.com/public-demo.mp4" \
  --output-dir "./video-results/public-demo" \
  --max-download-bytes 262144000 \
  --vision-provider xai --synthesis-provider openai
```

For a public video-platform page (single public video, no login/cookies; requires `yt-dlp`):

```bash
CUSTOM_API_KEY="<key>" python scripts/analyze_video.py \
  --url "https://www.bilibili.com/video/BVxxxxxxxxxx/" \
  --output-dir "./video-results/platform-demo" \
  --allow-platform --language zh \
  --custom-base-url https://api.relay.example/v1 --custom-model gpt-5.6-terra
```

#### Mode C — Current session model does the recognition (no external API)

1. Run the local pipeline and keep the frames:

   ```bash
   python scripts/analyze_video.py \
     --input "C:\\videos\\demo.mp4" \
     --output-dir "./video-results/demo" \
     --language zh --keep-artifacts
   ```

2. Read `transcript.json` and `frames.json`, then view the listed frame JPEGs yourself (in timestamp order) with your own multimodal input.
3. Cross-validate: compare what is visible in the frames against what the transcript says; where they contradict, report both readings with timestamps instead of picking one.
4. Write `agent_report.md` into the same output directory: timestamped chapters, key moments, the ASR-vs-visual cross-validation, limitations, and a provenance note stating that vision and synthesis were performed by the session model (name it), with zero external API calls and no frames sent anywhere. Do not overwrite the pipeline's deterministic `report.md`.

### Step 4 — Read results and report honestly

Read the evidence from the output directory — `timeline.json` (transcript and visual observations aligned into time windows), `vision.json`, `transcript.json` — and report to the user in their language: timestamped chapters/sections, key moments, and the cross-validation of what is said versus what is shown (contradictions must be surfaced with both readings and timestamps, never silently resolved). `analysis.json` and `report.md` carry the deterministic backbone (`provenance`, `limitations`) and are the audit record; when `--synthesis-provider` was used, `report.md` additionally contains the provider-generated report (and Mode C adds `agent_report.md`). **Exit code 0 does not mean a full analysis succeeded**: check `limitations` and `provenance.stages.*.status` and tell the user exactly which modalities were skipped or failed (`synthesis.status == "not_requested"` is the normal default, not a failure). Cite time ranges when describing the video. If the report lists missing modalities, state that limitation rather than inventing content.

## Runtime behavior

- **Runtime environment (ffmpeg, faster-whisper model, Python venv + packages) must be installed once** via the one-click installer in **Settings → 视频分析** or the prompt shown on the Skills page. The skill body (Python scripts) is bundled with the app; the heavy dependencies are downloaded on demand via China-first mirrors (Tsinghua/Aliyun pip, hf-mirror, ghproxy). An offline `setup_offline.bat` is also provided for air-gapped Windows machines.

### Acceleration pipeline (on by default)

The analyze script runs an optimized local pipeline **by default**; opt out with `--no-accelerate`. The TOKENICODE **视频分析加速** settings toggle remains compatible: sessions with the toggle on receive `TOKENICODE_VIDEO_ANALYSIS_ACCELERATE=1`, and `0` forces it off. Subprocess ASR isolation and greedy+VAD decoding apply to **every** run regardless of the toggle; the remaining optimizations are the acceleration path:

| Optimization | Effect |
|---|---|
| Subprocess ASR isolation | `faster-whisper` runs in a child process (`scripts/asr_worker.py`) with the OpenMP environment set **before** any import; a native OpenMP abort (the classic `libiomp5md.dll` vs `vcomp140.dll` conflict) kills only the worker, and the pipeline degrades to an honest "transcription failed" limitation instead of dying |
| Greedy decode + VAD | `beam_size=1` with silero VAD silence filtering for every ASR run — skips silent audio and decodes 3-5× faster than beam search |
| Scene-detection frame extraction (`scene > 0.3`) | A **single** ffmpeg pass keeps keyframes + scene-change frames with a minimum-density guarantee, skipping redundant frames in static shots (no second decode pass) |
| pHash perceptual dedup | Adjacent frames within 8% Hamming distance are dropped (numpy-vectorized DCT hash) |
| 2×2 frame grid stitching | Up to 4 frames packed into one timestamped JPEG that is **sent to the vision model as a single image**; ~75% fewer vision API calls. Each montage observation carries `source_timestamps` covering all of its cells |
| Parallel vision dispatch | Vision batches run concurrently (`--vision-concurrency`, default 4) while preserving submission order |
| Parallel audio + video lanes | Audio extraction/ASR runs concurrently with frame extraction/dedup/grids via `ThreadPoolExecutor` |
| Transcript + vision cache | Succeeded `transcript.json` / `vision.json` keyed by source SHA-256 + pipeline params; re-runs on the same video skip ASR and vision API calls entirely |
| CUDA `int8_float16` → CPU `int8` | GPU probed via `ctranslate2.get_cuda_device_count()` (no torch dependency); falls back to CPU on failure (`TOKENICODE_VIDEO_ASR_DEVICE=cpu` skips the probe) |

**Toggle precedence** (highest to lowest):
1. Explicit CLI flag: `--accelerate` forces on, `--no-accelerate` forces off
2. `TOKENICODE_VIDEO_ANALYSIS_ACCELERATE` env var (`1`/`0`, set by the settings toggle)
3. On by default

If any acceleration step fails (missing Pillow, GPU not available, etc.), the pipeline **falls back gracefully** to the standard path — it does not abort. The `analysis.json` `provenance.acceleration` block records what was requested, what was effective, the vision input form (`"grids"`/`"frames"`), and cache hits; `provenance.stage_durations_seconds` times every pipeline stage.

**Cache**: succeeded transcript and vision results are stored in `~/.tokenicode/video-cache/` (overridable via `TOKENICODE_VIDEO_CACHE_DIR` or `--accel-cache-dir`). Cache keys include source file SHA-256, pipeline version, ASR model, language, and threshold parameters — plus, for vision, the provider, model, frame interval, and whether grids were used. Only fully succeeded stages are cached (batch errors never enter the cache); entries are validated on load (manifest integrity, file existence, size match), and any cache error is treated as a miss — the cache can never fail the pipeline.

- `ffprobe` checks duration and streams before processing.
- With `--allow-platform`, a URL that serves HTML instead of direct media is fetched as a single public video via `yt-dlp` (`--no-playlist`, size and duration caps applied, no cookies or login ever). H.264 + m4a streams at ≤720p are preferred so that even older `ffmpeg` builds can merge the DASH parts and vision models (which downscale anyway) avoid wasted bandwidth. Login-gated, member-only, private, or DRM-protected content is refused with a clear limitation instead of being bypassed. The report's provenance records that the media came from platform extraction.
- `ffmpeg` produces a 16 kHz mono WAV and bounded JPEG key frames. Default sampling is every 3 seconds, which is suitable for typical short videos; use 1–2 seconds for UI/PPT tutorials and 3–5 seconds for talking-head videos.
- `faster-whisper` creates timestamped transcript segments. ASR failures are reportable but nonfatal: the pipeline writes an empty `transcript.json` and continues with any available visual evidence.
- When `--vision-provider openai` or `--vision-provider xai` is selected, the official `openai` Python SDK sends batches of JPEG frames as Base64 data URLs to the selected model. Each returned observation is forced back to the locally generated source timestamp.
- When `--vision-provider custom` is selected, the user-supplied OpenAI-compatible endpoint receives the same JPEG frames via Chat Completions `image_url` content parts. Before batching, the pipeline submits one test image to confirm the named model actually accepts image input; if the endpoint rejects it, frame interpretation is aborted with a clear limitation instead of failing every batch.
- The custom provider is auto-selected for the **vision stage** ONLY when the user-supplied key, `--custom-base-url`, and a model name are all present on the command line — this is the CLI completing the user's explicit choice, never an environment-based default. Synthesis is never auto-selected: it runs only with an explicit `--synthesis-provider`. The auto-selection is disclosed in the report limitations and provenance.
- Synthesis is opt-in: only when `--synthesis-provider openai`, `xai`, `deepseek`, or `custom` is passed explicitly does the pipeline generate its own report, sending only the text timeline evidence to that provider; it must cross-check transcript and visual evidence and surface contradictions. Without the flag, the calling agent reports from the evidence (Step 4).
- A selected provider failure degrades to the deterministic local report. It never silently switches to another vendor or sends artifacts elsewhere.
- The pipeline aligns transcript and visual observations into five-minute timeline windows and generates a final JSON report plus readable Markdown.
- The default maximum video duration is 10 minutes. For a longer authorized source, increase `--max-duration` deliberately and use `--segment-seconds 300`; the report remains split into time windows. Do not attempt frame-by-frame processing.

## Offline and staged verification

Use both skip flags to verify decoding and outputs without model credentials or an ASR model:

```bash
python scripts/analyze_video.py \
  --input sample.mp4 \
  --output-dir ./video-results/offline-check \
  --skip-asr --skip-vision
```

This is an **offline media-pipeline check**, not a video understanding result. It creates `media.json`, `frames.json`, `timeline.json`, `analysis.json`, and `report.md`, and marks audio and visual interpretation as unavailable.

## Output contract

The output directory contains:

- `media.json` — ffprobe metadata and source information (including `source.acquisition`: `local_file`, `direct_media_download`, or `platform_extraction`).
- `transcript.json` — ASR segments with timestamps, when ASR ran.
- `frames.json` — key-frame paths and estimated source timestamps.
- `vision.json` — provider frame observations and batch errors, when vision ran.
- `timeline.json` — merged time windows.
- `analysis.json` — title, summary, chapters, key moments, limitations, and per-stage provenance (read this first).
- `report.md` — deterministic, user-readable report with data-flow disclosure (provider-synthesized content only when `--synthesis-provider` was used).
- `agent_report.md` — Mode C only: the session model's own cross-validated report.

Temporary downloaded media, WAV audio, and frames are removed unless `--keep-artifacts` is supplied (Mode C requires it, since the session model reads the frames). A caller-supplied local source video is never deleted.

## Failure handling

- Treat blocked URL, download, platform-fetch refusal (login/member/DRM), merge/postprocessing failure, `ffprobe`, ASR, Vision, and synthesis errors as separate reportable failures.
- If a platform fetch fails on merging, tell the user: download the video themselves (authorized means only) and re-run with `--input` — the local-file path is the supported workaround.
- Keep successfully produced JSON artifacts when a later stage fails.
- Do not claim an end-to-end analysis succeeded when a modality was skipped, unavailable, or failed.
- Never select a provider implicitly: the pre-run interview answers (Mode A/B/C) are the only source of provider selection.
- Before a real external URL run, tell the user that it downloads media and may use ASR compute plus credits from the explicitly selected provider.
