# Video Analysis Skill

This personal Claude Code Skill analyzes **authorized** video files and public direct video URLs. It converts videos into timestamped evidence rather than sending a video stream to a model directly:

```text
local video / public direct video URL / public platform page (--allow-platform)
  -> ffprobe + ffmpeg (duration, audio, key frames)
  -> faster-whisper (timestamped transcript)
  -> selected vision provider (optional JPEG frame observations)
  -> synthesis provider ONLY when --synthesis-provider is passed (opt-in text timeline report)
  -> deterministic local report; the calling agent reads the evidence and reports
```

## Scope and authorization

Use only for video you own, have permission to process, or is publicly available for this purpose.

The downloader accepts only direct `http://` / `https://` media resources. It rejects private/local destinations and validates every redirect to reduce SSRF exposure. With `--allow-platform`, a URL that serves HTML instead of media is fetched as a **single public video** from a platform page via `yt-dlp` (see below). In all modes the skill does **not**:

- Send cookies, passwords, or authenticated headers, or log in to anything;
- Access member-only, private, friend-only, or age-gated videos;
- Bypass DRM, paywalls, login gates, geoblocks, or other access controls;
- Fetch playlists, channels, or batches of videos.

For restricted content, provide an authorized file, official export, or supported official API integration instead.

## Requirements

**All runtime dependencies are bundled in this directory — another agent or machine can use the skill with no downloads** (bundled binaries and wheels target Windows x64 + CPython 3.11):

| Component | Bundled at | Size | Notes |
| --- | --- | --- | --- |
| ffmpeg + ffprobe (Gyan 8.1.2 full build) | `bin/` | ~462 MB | Prepended to `PATH` automatically at script startup; works even when the host has no system ffmpeg |
| faster-whisper `small` ASR model | `models/faster-whisper-small/` | ~461 MB | The default `--asr-model small` loads from this directory, eliminating the ~460 MB first-run download |
| Python dependency wheels (openai, faster-whisper, requests, yt-dlp + transitive deps) | `wheelhouse/` (37 wheels) | ~89 MB | Installed offline by `setup_offline.bat` / `setup_offline.sh` |

The only prerequisite is **Python 3.10+ (64-bit)**. Environment API keys are needed only for explicitly selected remote providers:

- `OPENAI_API_KEY` for OpenAI vision and/or synthesis
- `XAI_API_KEY` for xAI Grok vision and/or synthesis
- `DEEPSEEK_API_KEY` for DeepSeek text synthesis only
- `CUSTOM_API_KEY` for a custom OpenAI-compatible endpoint (the variable name is configurable via `--custom-api-key-env`)

One-time offline setup (creates `.venv` and installs every dependency from the bundled wheelhouse — zero network needed):

```bat
:: cmd or double-click
setup_offline.bat
```

```bash
# Git Bash
./setup_offline.sh
```

After setup, run the skill with the venv interpreter (or activate it first: `source .venv/Scripts/activate` in Git Bash, `.venv\Scripts\Activate.ps1` in PowerShell):

```bash
.venv/Scripts/python.exe scripts/preflight.py --json
```

Online fallback for other platforms: `python -m pip install -r requirements.txt` (China mirror: `-i https://pypi.tuna.tsinghua.edu.cn/simple`) plus a system ffmpeg install — the scripts keep working with a system ffmpeg when `bin/` is absent.

Run a non-destructive environment check:

```bash
python scripts/preflight.py --json --vision-provider openai --synthesis-provider deepseek
```

It does not install software, contact providers, validate key contents, or alter environment variables. `offline_media_pipeline: true` means local probe/frame/audio processing can run. `requested_vision_ready` and `requested_synthesis_ready` describe only the providers you selected.

## Provider choices and data boundaries

Remote stages are disabled by default. Nothing is sent remotely unless you explicitly choose a provider. **There are no implicit provider defaults**: the skill's agent workflow (`SKILL.md` Step 0, `USAGE.md` §4) requires asking the user before every run whether to use a vision-capable model, and—if so—whether to use a user-supplied external endpoint or the multimodal model powering the current chat session. An API key merely present in the environment is never treated as authorization to use that vendor; DeepSeek is text-only and can never perform video frame recognition.

| Stage | Provider options | Receives | Notes |
| --- | --- | --- | --- |
| Vision | `none`, `openai`, `xai`, `custom` | JPEG frames as Base64 data URLs plus frame timestamps | DeepSeek is not allowed because its hosted API has no confirmed image-input contract. |
| Synthesis | `none`, `openai`, `xai`, `deepseek`, `custom` | Text timeline evidence, limitations, duration, source label | **Disabled by default** — runs only when `--synthesis-provider` is passed explicitly (headless/automated use); otherwise the calling agent reads the evidence and reports directly. DeepSeek is text-only. |

Fallback model IDs — used only when you explicitly select that vendor but pass no `--vision-model`/`--synthesis-model`; they are never an implicit vendor choice:

- OpenAI: `gpt-5`
- xAI: `grok-4.5`
- DeepSeek: `deepseek-v4-pro` (synthesis only — text-only, never receives images, never used for frame recognition)

xAI uses the fixed endpoint `https://api.x.ai/v1` through the official `openai` SDK. DeepSeek uses the fixed endpoint `https://api.deepseek.com`. Arbitrary base-URL overrides are intentionally not supported so the named provider matches the actual data destination.

If a selected provider fails, the pipeline falls back to the deterministic local report. It never automatically sends frames or transcript evidence to another vendor.

## Platform pages (public videos only)

A video-platform page (Bilibili/YouTube watch links and other `yt-dlp`-supported sites) can be analyzed when you opt in with `--allow-platform`. The page URL is fetched as one public video via `yt-dlp`, saved into the run's temporary processing directory, and then processed exactly like a local file:

```bash
python scripts/analyze_video.py \
  --url "https://www.bilibili.com/video/BVxxxxxxxxxx/" \
  --output-dir ./video-results/platform-demo \
  --allow-platform \
  --language zh
```

Hard rules (not configurable):

- Public, anonymously accessible videos only — no cookies, no login, no member/private/age-gated content; anything requiring authentication is refused with a clear error.
- No DRM circumvention — DRM-protected streams fail honestly.
- One video per run (`--no-playlist`); `--max-duration` and `--max-download-bytes` caps are enforced through `yt-dlp` filters.
- Stream selection prefers H.264 (avc1) video plus m4a audio so even older `ffmpeg` builds can merge the DASH parts, falling back to the best available streams. If merging still fails (e.g. an outdated local `ffmpeg`), the supported workaround is a local file you downloaded yourself, re-run with `--input` — never a credential or access-control workaround.
- The URL is still validated (scheme, no embedded credentials, no private/local addresses) before `yt-dlp` runs.
- Platform terms of service and content authorization are your responsibility; `report.md` and `analysis.json` provenance disclose that the media came from platform extraction.

## Custom OpenAI-compatible endpoint

Any endpoint that speaks the OpenAI Chat Completions protocol can be used with three pieces of information: the endpoint URL, an API key (environment variable), and the model name. As long as the model accepts image input, it can run the whole analysis:

```bash
export CUSTOM_API_KEY="sk-..."

python scripts/analyze_video.py \
  --input "C:\\videos\\demo.mp4" \
  --output-dir "C:\\video-results\\demo" \
  --custom-base-url https://api.relay.example/v1 \
  --custom-model gpt5.6-luna
```

When `--custom-base-url`, a model name, and the API key are all present on the command, the pipeline auto-selects the custom provider for the **vision stage only**. This completes an explicit user choice (the skill's pre-run interview collected these three pieces) — it is not an environment-based default: no vendor is ever selected just because its key exists. The auto-selection is disclosed in `report.md` limitations and provenance. **Synthesis is deliberately not auto-selected**: the default flow stops at timestamped evidence (`transcript.json` / `vision.json` / `timeline.json`) that the agent running the skill reads, cross-validates (speech vs visuals — contradictions surfaced with timestamps, not silently resolved), and reports to the user. Pass `--synthesis-provider custom` (or any provider) explicitly to have the pipeline generate its own report for headless/automated use. `--custom-model` names the model for both stages when synthesis is opted in; use `--vision-model`/`--synthesis-model` to override one stage, or spell out `--vision-provider custom --synthesis-provider custom` with per-stage models for full explicit control:

```bash
python scripts/analyze_video.py \
  --input "C:\\videos\\demo.mp4" \
  --output-dir "C:\\video-results\\demo" \
  --vision-provider custom \
  --custom-base-url https://api.relay.example/v1 \
  --vision-model gpt5.6-luna \
  --synthesis-provider custom \
  --synthesis-model gpt5.6-luna
```

Rules for the custom route:

- `--custom-base-url` must be `https://` (or loopback `http://` such as `http://127.0.0.1:8080` for a local relay), so API keys are never sent in plaintext.
- The model name is required: `--custom-model` for both stages, or `--vision-model` and/or `--synthesis-model` per stage.
- Vision requests use the classic Chat Completions shape (`image_url` content parts with Base64 data URLs), which is the most widely supported format across relays and local gateways.
- Before sending frames, the skill verifies the model can actually see: first it queries `GET {base}/models/{model}` when available and fails early if the endpoint conclusively reports no image input; then it submits one test image through the normal chat route. Vision-capable models answer the probe; text-only models reject the `image_url` content, and the run aborts frame interpretation with a clear message in `vision.json` and limitations instead of failing every batch. If the endpoint exposes no capability metadata, the test-image probe is the decisive check.
- Synthesis through a custom endpoint (opt-in via `--synthesis-provider`) is text-only.
- The actual endpoint URL is disclosed in `analysis.json` provenance and in `report.md`; the API key is never recorded.
- Optional preflight capability probe:

```bash
python scripts/preflight.py --json \
  --vision-provider custom \
  --custom-base-url https://api.relay.example/v1 \
  --custom-probe-model gpt5.6-luna
```

## Vision via the current chat session's model

The agent workflow offers a third route besides external providers: the multimodal model powering the chat session reads the extracted frames itself — no API key, no external call:

1. Run the pipeline with `--keep-artifacts` and no provider flags (local ASR + frame extraction only).
2. The agent reads `frames.json` and `transcript.json`, views the frame JPEGs in timestamp order, cross-checks them against the transcript (contradictions reported, not silently resolved), and writes `agent_report.md` into the output directory.

The pipeline's deterministic `report.md` is left untouched; `agent_report.md` states which session model performed vision and synthesis and that no frames left the machine.

## Run the pipeline

### Authorized local file with OpenAI vision and DeepSeek synthesis

```bash
python scripts/analyze_video.py \
  --input "C:\\videos\\demo.mp4" \
  --output-dir "C:\\video-results\\demo" \
  --frame-interval 3 \
  --language zh \
  --vision-provider openai \
  --synthesis-provider deepseek \
  --keep-artifacts
```

### Authorized public direct-media URL with xAI vision and OpenAI synthesis

```bash
python scripts/analyze_video.py \
  --url "https://media.example.com/authorized-demo.mp4" \
  --output-dir ./video-results/authorized-demo \
  --frame-interval 3 \
  --max-duration 600 \
  --max-download-bytes 262144000 \
  --vision-provider xai \
  --synthesis-provider openai
```

A URL run can download media, use local ASR compute, and use credits from the explicitly selected providers. Inspect the target URL and its authorization before running it.

### Reporting: agent-first, synthesis opt-in

By default the pipeline produces timestamped evidence (`transcript.json`, `vision.json`, `timeline.json`) plus a deterministic `report.md`; the agent running the skill reads the evidence and reports to the user, cross-validating what is said against what is shown. Adding `--synthesis-provider` makes the pipeline additionally generate its own report from the text timeline — intended for headless/automated runs without an agent present. ASR and vision are independent: when synthesis is enabled and ASR fails but vision succeeds, it runs from visual observations; when vision fails or is disabled but a transcript exists, from transcript evidence; when neither is available, the deterministic report is produced.

### Offline media-only verification

Use this before supplying API keys or downloading ASR models:

```bash
python scripts/analyze_video.py \
  --input sample.mp4 \
  --output-dir ./video-results/offline-check \
  --skip-asr --skip-vision
```

This validates video decoding and timestamp generation only. The report will explicitly say that speech and visual meaning were not analyzed. `--skip-vision` is equivalent to `--vision-provider none` and cannot be combined with a remote vision provider.

## Acceleration

The pipeline runs an accelerated local path **by default** (opt out with `--no-accelerate`; the TOKENICODE settings toggle stays compatible via `TOKENICODE_VIDEO_ANALYSIS_ACCELERATE=1/0`). What it changes:

- **Fewer vision calls**: frames are extracted in a single scene-aware ffmpeg pass, deduplicated by perceptual hash, then packed into 2×2 montage images that are sent to the vision model as single images — roughly 4× fewer requests. Montage observations carry `source_timestamps` covering all of their cells. Vision batches also dispatch concurrently (`--vision-concurrency`, default `4`) while preserving submission order.
- **Faster, crash-isolated ASR**: `faster-whisper` runs in a child process (`scripts/asr_worker.py`) with greedy decoding (`beam_size=1`) and silero VAD silence filtering — applied to every run, with or without acceleration. The OpenMP environment is set before the process starts, so a native OpenMP abort (the classic Windows `libiomp5md.dll` vs `vcomp140.dll` conflict) kills only the worker; the pipeline reports transcription as failed and continues with visual evidence.
- **Parallel lanes**: audio extraction + ASR run concurrently with frame extraction + dedup + montage stitching.
- **Content cache**: succeeded `transcript.json` and `vision.json` results are cached in `~/.tokenicode/video-cache/` (override: `--accel-cache-dir` or `TOKENICODE_VIDEO_CACHE_DIR`), keyed by source SHA-256 + pipeline parameters; re-running the same video skips ASR and vision work entirely. Only succeeded stages are cached, corrupted entries are recomputed transparently, and cache errors never fail the pipeline.

Explicit CLI flags take precedence over the environment variable, which takes precedence over the default (on). If any acceleration step is unavailable (e.g. Pillow missing for montage stitching), the pipeline falls back to the standard path for that step. `analysis.json` records what was requested vs effective under `provenance.acceleration` and times every stage under `provenance.stage_durations_seconds`.

## Output files

| File | Contents |
| --- | --- |
| `media.json` | Source label plus `ffprobe` stream/container data, duration, and how the media was acquired (`local_file`, `direct_media_download`, or `platform_extraction`). |
| `frames.json` | Extracted frame timestamps and paths; paths are retained only with `--keep-artifacts`. |
| `transcript.json` | Timestamped speech segments, when ASR ran; empty list when ASR failed or was skipped. |
| `vision.json` | Selected-provider frame observations or batch errors, when vision ran. |
| `timeline.json` | ASR and visual evidence aligned into time windows. |
| `analysis.json` | Structured final report with per-stage provenance, limitations, per-stage timings (`provenance.stage_durations_seconds`), and the acceleration record (`provenance.acceleration`). |
| `report.md` | Deterministic, readable, timestamped summary including provider and data-handling disclosure (provider-synthesized content only when `--synthesis-provider` was used). |

Without `--keep-artifacts`, temporary downloaded media, WAV audio, and JPEGs are removed after creating the JSON/Markdown report. The source file passed with `--input` is never deleted.

## Key parameters

- `--frame-interval`: seconds between frames (default `3`). Use `1–2` for software tutorials and slide decks; use `3–5` for talking-head videos.
- `--max-duration`: hard duration upper bound in seconds (default `600`).
- `--segment-seconds`: timeline window size (default `300`).
- `--max-download-bytes`: hard streaming download cap (default `262144000`, 250 MiB).
- `--allow-platform`: when `--url` is a platform page rather than direct media, fetch the single public video with `yt-dlp` (no login/cookies ever; public videos only).
- `--asr-model`: faster-whisper model name (default `small`).
- `--language`: optional ASR language code such as `zh` or `en`.
- `--vision-batch-size`: number of frames sent per vision request (default `8`).
- `--vision-concurrency`: number of vision batches dispatched in parallel (default `4`; `1` forces serial). Observations are always returned in submission order.
- `--accelerate` / `--no-accelerate`: force the acceleration pipeline on/off (default: on — see **Acceleration** below).
- `--accel-cache-dir`: transcript + vision cache directory (default `~/.tokenicode/video-cache`; also overridable via `TOKENICODE_VIDEO_CACHE_DIR`).
- `--vision-provider`: `none`, `openai`, `xai`, or `custom` (default `none`; auto-selected as `custom` when base URL, model, and key are all supplied).
- `--vision-model`: optional model override for the selected vision provider; required for `custom` (filled by `--custom-model`).
- `--synthesis-provider`: `none`, `openai`, `xai`, `deepseek`, or `custom` (default `none`; **never auto-selected** — the default flow leaves synthesis off so the calling agent reports from the evidence; pass this flag for headless/automated report generation).
- `--synthesis-model`: optional model override for the selected synthesis provider; required for `custom` (filled by `--custom-model`).
- `--custom-base-url`: OpenAI-compatible endpoint URL for provider `custom` (HTTPS, or loopback HTTP).
- `--custom-model`: model name applied to both custom stages unless overridden per stage.
- `--custom-api-key-env`: environment variable holding the custom endpoint key (default `CUSTOM_API_KEY`).
- `--skip-asr`, `--skip-vision`: run an honest partial pipeline when dependencies or credentials are unavailable.
- `--keep-artifacts`: preserve downloaded source, WAV, and JPEGs under `.processing/` for audit/debugging.

## Testing

The included tests make a small synthetic video locally with ffmpeg and use mocks for ASR and remote providers, so they do not use an API key, external network, user data, or billable provider calls:

```bash
python -m unittest discover -s tests -v
```

The suite skips the media integration test when ffmpeg/ffprobe are unavailable. It tests URL policy, redirect handling, local media decoding, timestamp alignment, provider request boundaries, DeepSeek text-only enforcement, custom endpoint chat-completions boundaries, the image-input probe for vision-capable vs text-only custom models, custom key+endpoint+model auto-selection, honest skipped-modality output, and preflight readiness reporting.
