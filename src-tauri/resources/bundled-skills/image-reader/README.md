# Image Reader Skill

A TOKENICODE / Little Claude skill that gives **text-only models the ability to read images**. The agent delegates image recognition to an external vision-capable model through an OpenAI-compatible endpoint and receives the result as plain text it can reason over:

```text
agent without vision (e.g. DeepSeek)
  -> describe_image.py  (Python stdlib only — no pip install)
       -> base64-encode the local image (or pass a public image URL)
       -> POST {base}/chat/completions with image_url content parts
       -> print the vision model's text answer on stdout
  -> agent reasons over the text, cites the external model as the source
```

It is the image-level counterpart of the bundled `video-analysis` skill and **reuses the same multimodal configuration**: if you already saved a default multimodal model in **Settings → 视频分析**, this skill works with zero extra setup — TOKENICODE injects `TOKENICODE_VIDEO_ANALYSIS_BASE_URL` / `TOKENICODE_VIDEO_ANALYSIS_MODEL` / `CUSTOM_API_KEY` into every Claude session.

## Requirements

- **Python 3.9+** — that is all. The script uses only the standard library.
- An OpenAI-compatible endpoint with a vision-capable model (Qwen-VL, GLM-4V, GPT-4o, Gemini via relay, local llama.cpp/Ollama with a vision model, …).

## Installation

Skills are discovered by the Claude CLI from `~/.claude/skills/`. Copy this directory there:

```bash
# macOS / Linux / Git Bash
cp -r src-tauri/resources/bundled-skills/image-reader ~/.claude/skills/

# Windows (PowerShell)
Copy-Item -Recurse src-tauri\resources\bundled-skills\image-reader $env:USERPROFILE\.claude\skills\
```

In packaged TOKENICODE builds the skill body is also embedded in the binary and extracted to `%LOCALAPPDATA%/tokenicode/embedded-skills/image-reader/` (alongside `video-analysis`); copy or symlink it from there if you prefer. The app's Skills page additionally scans `~/.agents/skills/` and the project's `.claude/skills/`.

## Quick start

```bash
# Describe an image (Chinese answer)
python ~/.claude/skills/image-reader/scripts/describe_image.py shot.png --lang zh

# OCR: extract all visible text verbatim
python ~/.claude/skills/image-reader/scripts/describe_image.py scan.jpg --ocr

# Explicit endpoint (key via environment — never on disk)
CUSTOM_API_KEY="sk-..." python ~/.claude/skills/image-reader/scripts/describe_image.py \
  chart.png --base-url https://dashscope.aliyuncs.com/compatible-mode/v1 --model qwen-vl-max
```

## Configuration sources (highest priority first)

| Setting | Command line | Skill env var | App-injected env var (Settings → 视频分析) |
| --- | --- | --- | --- |
| Endpoint | `--base-url` | `TOKENICODE_IMAGE_READER_BASE_URL` | `TOKENICODE_VIDEO_ANALYSIS_BASE_URL` |
| Model | `--model` | `TOKENICODE_IMAGE_READER_MODEL` | `TOKENICODE_VIDEO_ANALYSIS_MODEL` |
| API key | `--api-key` / `--api-key-env` | `TOKENICODE_IMAGE_READER_API_KEY` | `CUSTOM_API_KEY` / `TOKENICODE_VIDEO_ANALYSIS_API_KEY` |

The endpoint must be `https://` (or `http://` only for loopback relays such as `http://127.0.0.1:11434/v1`), so keys never travel in plaintext. Like video-analysis, the skill never selects a vendor implicitly from unrelated environment keys.

## Privacy and safety

- Local images are Base64-encoded and sent **only** to the configured endpoint.
- Public image URLs are handed to the endpoint by default (the endpoint fetches them); `--no-pass-url` downloads and embeds them locally instead. Script-side downloads refuse private, loopback, link-local, reserved, and metadata-service addresses, and re-validate every redirect.
- The API key is never printed, logged, or written to any file.
- A failed endpoint never fails over to another vendor — the script reports the error and stops.

See `USAGE.md` for the full flag reference, exit codes, and recipes, and `SKILL.md` for the contract the agent follows.

## Tests

```bash
python -m unittest discover -s tests -v
```

All tests run offline (the HTTP layer is stubbed).
