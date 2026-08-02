# image-reader — CLI reference

`scripts/describe_image.py` sends one or more images to a vision-capable model through an OpenAI-compatible Chat Completions endpoint and prints the recognition result. Python 3.9+ standard library only.

```bash
python describe_image.py IMAGE [IMAGE ...] [options]
```

Each `IMAGE` is one of:

- a local file path (PNG, JPEG, GIF, WebP, BMP; ≤ `--max-image-mb`),
- a public `http://` / `https://` image URL,
- an inline `data:image/<fmt>;base64,<payload>` URL.

## Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--lang zh\|en` | `en` | Language of the built-in prompt and expected answer |
| `--prompt "TEXT"` | — | Custom instruction to the vision model (overrides the built-in prompt; write it in the user's language) |
| `--ocr` | off | Extract all visible text verbatim instead of describing |
| `--detail auto\|low\|high` | omitted | `detail` hint on the `image_url` part (cost/quality control) |
| `--json` | off | Machine-readable result: `{ok, description, images[], model, endpoint_host, elapsed_seconds}` |
| `--no-pass-url` | pass-through | Download http(s) image URLs and embed them as Base64 instead of handing the URL to the endpoint |
| `--base-url URL` | env | OpenAI-compatible base URL; must be `https://` (or loopback `http://`) |
| `--model NAME` | env | Vision model name |
| `--api-key KEY` | env | Key value on the command line (prefer the environment; never persisted) |
| `--api-key-env VAR` | `CUSTOM_API_KEY` | Name of the env var that holds the key |
| `--timeout SEC` | `120` | Network timeout per request |
| `--max-image-mb N` | `18` | Per-image size cap for local/downloaded images |
| `--max-images N` | `8` | Maximum images in one request |
| `--max-tokens N` | — | Optional response length cap sent to the endpoint |

## Configuration sources

Priority: command line > `TOKENICODE_IMAGE_READER_BASE_URL` / `_MODEL` / `_API_KEY` > TOKENICODE app injection from **Settings → 视频分析** (`TOKENICODE_VIDEO_ANALYSIS_BASE_URL` / `_MODEL`, key via `CUSTOM_API_KEY` or `TOKENICODE_VIDEO_ANALYSIS_API_KEY`).

When TOKENICODE injects `TOKENICODE_VIDEO_ANALYSIS_MULTIMODAL_READY=1`, all three values are complete and you only need to forward base URL and model on the command line — the script finds the key itself.

## Output contract

- **stdout** — the vision model's answer (plain text), or the JSON result with `--json`. Nothing else, so agents can pipe it directly.
- **stderr** — one provenance line: `[image-reader] model=<m> endpoint=<host> images=<n> key_from=<source label> elapsed=<s>s`, plus errors. The key value itself never appears anywhere.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 2 | Configuration error — endpoint/key/model missing or invalid, key rejected (HTTP 401/403) |
| 3 | Input error — file missing, unsupported format, oversize image, blocked URL |
| 4 | API error — endpoint unreachable, non-2xx response, no usable text in the answer |

## Recipes

Describe a screenshot for a Chinese-speaking user:

```bash
python describe_image.py "C:\work\ui.png" --lang zh
```

Pure OCR on a scan:

```bash
python describe_image.py scan.jpg --ocr --lang zh
```

Compare two screenshots in one request (single vision call, sectioned answer):

```bash
python describe_image.py old.png new.png --lang zh \
  --prompt "对比这两张界面截图，逐项列出差异（布局、文字、颜色、控件状态）。"
```

Read a public image URL, embedding it locally instead of letting the endpoint fetch it:

```bash
python describe_image.py "https://example.com/public-chart.png" --no-pass-url
```

JSON for scripting (per-image metadata + description):

```bash
python describe_image.py frame_*.png --json --detail low --max-images 8
```

PowerShell with the app-injected defaults:

```powershell
python "$env:USERPROFILE\.claude\skills\image-reader\scripts\describe_image.py" `
  "shot.png" --lang zh `
  --base-url $env:TOKENICODE_VIDEO_ANALYSIS_BASE_URL `
  --model $env:TOKENICODE_VIDEO_ANALYSIS_MODEL
```

One-shot key pasted in chat (never persisted):

```bash
CUSTOM_API_KEY="sk-..." python describe_image.py shot.png \
  --base-url https://api.relay.example/v1 --model gpt-4o
```

## Troubleshooting

- **HTTP 404 / model_not_found** — the model name is probably wrong for this relay. Check `GET {base}/models` (with the same bearer key) for the exact IDs the endpoint enables.
- **HTTP 401 / 403** — key rejected; verify it with the user. The error states which source the key came from.
- **"does not support image input"** behavior — the configured model is text-only; ask the user for a vision-capable model name.
- **Blocked URL** — the SSRF guard refused a private/loopback image URL. Download the image yourself and pass the local path.
- **Windows `$HOME` oddity** — in some shells (Git Bash on a non-C: home) `$HOME` expands to the wrong drive; use the absolute path to the script instead.
