---
name: image-reader
description: Read, describe, or extract text (OCR) from an image — screenshots, photos, charts, diagrams, UI mockups, scanned documents — by delegating to an external vision-capable model through an OpenAI-compatible endpoint. Use this skill whenever the user asks to look at, view, describe, recognize, OCR, or answer questions about an image file, or whenever you need visual information from an image to continue your task — ESPECIALLY when the current session model cannot see images itself (text-only models such as DeepSeek). The skill ships a zero-dependency Python script (stdlib only, no pip install) that encodes the image locally, sends it to the configured vision endpoint, and prints the recognition result as text you can reason over. If TOKENICODE has a complete default multimodal model (env TOKENICODE_VIDEO_ANALYSIS_MULTIMODAL_READY=1 with base URL, API key, model — saved in Settings → 视频分析), that endpoint is used automatically; otherwise ask the user for the API endpoint (Base URL), API key (or key env-var name), and a vision model name. Never fabricate image content: if no vision route is available or the script fails, say so plainly instead of guessing what the image contains.
---

# Image Reader — eyes for a text-only model

This skill lets **you** recognize images even when your own model has no vision capability. A bundled, zero-dependency Python script encodes the image locally, sends it to an explicitly configured OpenAI-compatible vision endpoint, and prints the recognition result as plain text on stdout. You then reason over that text exactly as you would over any other evidence.

## Golden rules

1. **Never fabricate visual content.** If you cannot see the image and this skill did not return a description (not configured, script failed, no key), say so plainly. Never describe an image you have no textual evidence for, and never present a guess as observation.
2. **Never try to read the image file yourself.** Reading binary image bytes gives you nothing useful — always run the script. (Reading EXIF/metadata is fine but is not image understanding.)
3. **Disclose provenance.** Tell the user the description came from the external vision model named on the script's stderr provenance line (model + endpoint host), not from your own eyes. Keep any "uncertain / illegible" caveats the vision model reported.
4. **Privacy disclosure before sending.** Images leave this machine and travel to the configured endpoint. Before the first run in a session, state in one line which model @ endpoint host will receive the image. Never print or persist the API key.

## Authorized inputs only

- Local image files the user is authorized to send: PNG, JPEG, GIF, WebP, BMP (≤18 MB each by default).
- Public `http(s)` image URLs. By default the URL is handed to the vision endpoint (the endpoint fetches it — tell the user this). With `--no-pass-url` the script downloads and embeds the image instead; script-side downloads refuse private, loopback, link-local, reserved, and metadata-service addresses and re-validate every redirect. Do not weaken these checks and do not work around them.

## Workflow

### Step 0 — Choose the vision route (TOKENICODE defaults first)

**Never pick a random vendor just because an unrelated key is in the environment** (e.g. `DEEPSEEK_API_KEY` present ≠ permission to use DeepSeek for vision — DeepSeek is text-only). Provider selection comes only from the app defaults or the user's explicit answer.

#### TOKENICODE default multimodal model (zero-config path)

TOKENICODE / Little Claude injects these environment variables into the Claude session when the user saved a default multimodal model in **Settings → 视频分析** (the same configuration the video-analysis skill uses):

| Env var | Meaning |
| --- | --- |
| `TOKENICODE_VIDEO_ANALYSIS_MULTIMODAL_READY=1` | Defaults are complete and the secret was resolvable |
| `TOKENICODE_VIDEO_ANALYSIS_BASE_URL` | OpenAI-compatible base URL |
| `TOKENICODE_VIDEO_ANALYSIS_MODEL` | Vision-capable model name |
| `TOKENICODE_VIDEO_ANALYSIS_API_KEY` | Resolved secret (also mirrored as `CUSTOM_API_KEY`) |
| `CUSTOM_API_KEY` | Same resolved secret; the script's default key source |

**If `TOKENICODE_VIDEO_ANALYSIS_MULTIMODAL_READY=1` and base URL + model are non-empty:**

1. One-line notice in the user's language, naming the **model** and **endpoint host only** (never the key), e.g. 「将由设置中的多模态模型 `qwen-vl-max`（endpoint host）识别这张图片」.
2. Run the script passing only `--base-url "$TOKENICODE_VIDEO_ANALYSIS_BASE_URL"` and `--model "$TOKENICODE_VIDEO_ANALYSIS_MODEL"` — the key is already injected as `CUSTOM_API_KEY`, the script picks it up by itself.
3. Do **not** re-ask the user unless the run fails with an auth (exit 2) or model error.

**If the defaults are missing or incomplete:** ask the user (in their language):

> 我当前的模型无法直接看到图片，需要借助一个具备视觉识别能力的模型来读取它。请提供 OpenAI 兼容的 **API 端点 (Base URL)**、**API Key（或存放 Key 的环境变量名）**、**视觉模型名称**；也可以在 **设置 → 视频分析** 中填写一次，之后每次会话都会自动注入。

English equivalent if the user speaks English. Collect all three; if any piece is missing, **ask again for the missing field(s)** — do not invent defaults. Prefer receiving the key as an environment variable name or via the app settings; if the user pastes a key in chat, set it inline on the command (`CUSTOM_API_KEY="<key>" python ...`) — never persist it, never echo it back.

**If the current session model itself is multimodal**, you can view the image directly and do not need this skill — but running it is still valid when the user wants a specific external model's reading.

### Step 1 — Run the script

Basic run (Chinese-speaking user → `--lang zh`):

```bash
python "$HOME/.claude/skills/image-reader/scripts/describe_image.py" \
  "C:\\projects\\shot.png" --lang zh
```

On Windows, `$HOME` may expand to a wrong drive in some shells (e.g. Git Bash mapping it to `D:\...`); if the file is not found, use the absolute path, e.g. `python "C:/Users/<user>/.claude/skills/image-reader/scripts/describe_image.py" ...`.

With the TOKENICODE defaults injected:

```bash
python "$HOME/.claude/skills/image-reader/scripts/describe_image.py" \
  "screenshot.png" --lang zh \
  --base-url "$TOKENICODE_VIDEO_ANALYSIS_BASE_URL" \
  --model "$TOKENICODE_VIDEO_ANALYSIS_MODEL"
```

PowerShell:

```powershell
python "$env:USERPROFILE\.claude\skills\image-reader\scripts\describe_image.py" `
  "screenshot.png" --lang zh `
  --base-url $env:TOKENICODE_VIDEO_ANALYSIS_BASE_URL `
  --model $env:TOKENICODE_VIDEO_ANALYSIS_MODEL
```

User pasted a key in chat (one-shot, never persisted):

```bash
CUSTOM_API_KEY="<key>" python scripts/describe_image.py "shot.png" --lang zh \
  --base-url https://api.relay.example/v1 --model qwen-vl-max
```

Frequently used flags (full reference in `USAGE.md`):

| Flag | Effect |
| --- | --- |
| `--lang zh\|en` | Language of the default prompt/answer (pass `zh` for Chinese users) |
| `--ocr` | Extract visible text verbatim instead of describing |
| `--prompt "..."` | Custom instruction (write it in the user's language) |
| `--json` | Machine-readable output with per-image metadata |
| `--no-pass-url` | Embed http(s) image URLs as Base64 instead of handing the URL to the endpoint |
| `--detail low\|high\|auto` | Vision detail hint for cost/quality control |
| `--max-tokens N` | Cap the response length |

### Step 2 — Use the result honestly

- **stdout** carries the vision model's answer; **stderr** carries one provenance line (`[image-reader] model=... endpoint=... images=... key_from=... elapsed=...s`). Quote the answer as the vision model's words, not yours.
- Present the content faithfully, including any uncertainty or "illegible" caveats. If the answer is insufficient for the user's question, re-run with a targeted `--prompt` asking exactly what is needed — do not fill gaps with invention.
- Multiple images in one call are answered in one sectioned reply (use it for "compare these two screenshots"). For more than 8 images, batch the calls.

## Exit codes and failure handling

| Code | Meaning | Your move |
| --- | --- | --- |
| 0 | Success | Use stdout |
| 2 | Configuration error (endpoint/key/model missing, invalid URL, key rejected 401/403) | Ask the user to correct the config; suggest Settings → 视频分析 for persistence |
| 3 | Input error (file missing, unsupported format, oversize, blocked URL) | Fix the path/format; for oversized images ask the user to resize — never weaken the URL guard |
| 4 | API error (unreachable endpoint, HTTP error, unusable answer) | Report the error; if 404, the model name is likely wrong — suggest checking `GET {base}/models` |

- **Never fail over to another vendor** and never retry against a different endpoint than the one configured: report the failure and let the user decide (same rule as the video-analysis skill).
- If a HTTP URL image fails, you may suggest `--no-pass-url` (script downloads + embeds) as a legitimate retry — that is the same endpoint, not a vendor switch.
- The script requires **no pip packages** (Python 3.9+ stdlib only). If `python` is missing entirely, tell the user; do not install a Python distribution silently.

## Data boundary (state this when relevant)

- Local files are Base64-embedded and sent only to the configured endpoint.
- Public image URLs are, by default, passed to the endpoint which fetches them itself; `--no-pass-url` routes the download through the local machine (public addresses only).
- The API key is read from the environment or an explicit flag, travels only in the HTTPS Authorization header, and never appears in stdout, stderr, or any file.
