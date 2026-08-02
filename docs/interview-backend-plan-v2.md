# 面试秒出答案 — 后端实现方案 v2（双引擎）

**日期**: 2026-07-26
**状态**: 待执行

---

## 一、核心问题

faster-whisper 底层是 CTranslate2，只支持 **CUDA** 和 **CPU** 两种推理后端。
Intel 核显、AMD 显卡完全没有加速路径。纯 CPU 跑 large-v3 模型无法满足面试实时性要求。

**解决**: 引入 **whisper.cpp** 作为第二引擎，补齐 Vulkan/Metal/CPU 后端。

---

## 二、双引擎架构

```
                    ┌─────────────────────────────┐
                    │   Rust: engine_selector.rs   │
                    │   检测硬件 → 自动选择引擎      │
                    └──────────┬──────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
    ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
    │ NVIDIA GPU  │  │ Intel / AMD │  │ Apple       │
    │ CUDA ≥ 4GB  │  │ 核显 / 独显  │  │ Silicon     │
    │             │  │ Vulkan      │  │ Metal       │
    └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
           │                │                │
           ▼                ▼                ▼
    ┌────────────┐   ┌──────────────┐   ┌──────────────┐
    │faster-     │   │whisper.cpp   │   │whisper.cpp   │
    │whisper     │   │Vulkan 后端    │   │Metal 后端     │
    │CUDA 后端    │   │              │   │              │
    │(Python)    │   │(C++ binary)  │   │(C++ binary)  │
    └─────┬──────┘   └──────┬───────┘   └──────┬───────┘
          │                 │                   │
          └─────────┬───────┴───────────────────┘
                    │
                    ▼
           ┌───────────────┐
           │  asr_trait.rs  │
           │  统一 JSON 协议 │
           │  start/trans-  │
           │  cribe/shutdown│
           └───────┬───────┘
                   │
                   ▼
           ┌───────────────┐
           │  pipeline.rs   │
           │  VAD + Claude  │
           │  answer gen    │
           └───────────────┘
```

---

## 三、引擎选择逻辑

```
检测顺序:
  1. nvidia-smi 可用 + 显存 ≥ 4GB → engines: [{id: "faster-whisper", backend: "cuda", model: "large-v3"}]
  2. Metal (sysctl machdep) → engines: [{id: "whisper-cpp", backend: "metal", model: "large-v3-q5"}]
  3. Vulkan 设备存在 → engines: [{id: "whisper-cpp", backend: "vulkan", model: "medium-q5"}]
  4. 纯 CPU AVX2 → engines: [{id: "whisper-cpp", backend: "cpu", model: "base-q5"}]
  5. 纯 CPU 无 AVX2 → engines: [{id: "whisper-cpp", backend: "cpu", model: "tiny-q5"}]

用户可在"面试助手"设置中手动切换引擎和模型。
```

| 用户硬件 | 引擎 | 后端 | 推荐模型 | 实时性 |
|----------|------|------|---------|--------|
| NVIDIA 8GB+ | faster-whisper | CUDA | large-v3 | 🟢 5x |
| NVIDIA 4-6GB | faster-whisper | CUDA | medium | 🟢 3x |
| NVIDIA <4GB | whisper-cpp | Vulkan/CUDA | small-q5 | 🟡 1.5x |
| Apple M1-4 | whisper-cpp | Metal | large-v3-q5 | 🟢 2-4x |
| Intel 核显 | whisper-cpp | Vulkan | medium-q5 | 🟡 1-2x |
| AMD 核显/独显 | whisper-cpp | Vulkan | medium-q5 | 🟡 1-3x |
| 纯 CPU (近5年) | whisper-cpp | CPU/AVX2 | base-q5 | 🟡 勉强实时 |
| 纯 CPU (老旧) | whisper-cpp | CPU | tiny-q5 | 🔴 难实时 |

**结论**: 无论用户只有 CPU 还是核显，都能运行。唯一牺牲的是模型精度（tiny/base 替代 large），但不会完全不可用。

---

## 四、依赖清单

| 层 | 依赖 | 用途 | 用户需要安装? |
|----|------|------|-------------|
| Python | faster-whisper + silero-vad + soundfile | NVIDIA 用户的 ASR 引擎 | auto-install |
| C++ | whisper.cpp (预编译) | CPU/核显/AMD/Apple 的 ASR 引擎 | 打包进 app |
| GGML | ggml-*.bin 模型文件 | whisper.cpp 模型 | auto-download |
| Rust | tokio::process | 子进程管理 | 已有 |
| Rust | serde_json | JSON 协议 | 已有 |
| Rust | base64 | 前端音频解码 | `cargo add base64` |
| Rust | sysinfo / nvml-wrapper | 硬件探测 | `cargo add sysinfo` |
| 前端 | Web Audio API | 麦克风采集 + WAV 编码 | 浏览器内置 |

**用户不需要手动安装任何东西。** 应用程序首次运行时自动检测硬件、自动选择引擎、自动下载模型。

---

## 五、子进程 JSON 协议（统一）

两个引擎使用相同协议，Rust 层不关心底层是 Python 还是 C++。

```
Rust → 引擎:
  {"id":"req_1", "action":"transcribe", "audio_path":"/tmp/interview/c001.wav"}
  {"id":"req_2", "action":"vad",        "audio_path":"/tmp/interview/c001.wav"}
  {"id":"req_3", "action":"shutdown"}

引擎 → Rust:
  {"type":"loaded",    "engine":"faster-whisper", "model":"large-v3",   "device":"cuda"}
  {"type":"loaded",    "engine":"whisper-cpp",    "model":"medium-q5",  "device":"vulkan"}
  {"type":"transcription","id":"req_1","text":"你好请问","segments":[{"start":0,"end":1.2,"text":"你好..."}]}
  {"type":"vad",        "id":"req_2","speech_prob":0.98,"is_speech":true}
  {"type":"error",      "id":"req_1","message":"transcription failed"}
  {"type":"progress",   "phase":"downloading","percent":45,"message":"downloading model..."}
  {"type":"shutdown"}
```

---

## 六、新增/修改文件

```
src-tauri/
├── src/
│   └── interview/
│       ├── mod.rs             # 模块入口
│       ├── asr_trait.rs       # 统一 trait: AsrEngine { start, transcribe, vad, shutdown }
│       ├── engine_selector.rs # 硬件探测 + 引擎选择
│       ├── faster_whisper.rs  # Python 子进程引擎
│       ├── whisper_cpp.rs     # whisper-cli 子进程引擎
│       ├── pipeline.rs        # VAD 边界检测 + Claude 答案生成编排
│       └── protocol.rs        # JSON 类型定义
│
├── binaries/                  # ⚠ 需打包进 Tauri bundle
│   ├── whisper-cli-x86_64-pc-windows-msvc.exe
│   ├── whisper-cli-x86_64-apple-darwin
│   └── whisper-cli-aarch64-apple-darwin
│
scripts/
├── interview_asr.py           # faster-whisper sidecar
└── download_models.py         # 模型下载脚本 (GGML .bin 文件)

src/
├── hooks/
│   └── useAudioCapture.ts     # 麦克风采集 (MediaRecorder + WAV 编码)
└── lib/
    └── tauri-bridge.ts        # +invoke 方法

Cargo.toml                     # +base64, +sysinfo, +nvml-wrapper
tauri.conf.json                # +binaries 资源打包
```

---

## 七、执行步骤（6步）

### 步骤① Rust interview 模块骨架 + 协议定义

**文件**: `interview/mod.rs`, `interview/protocol.rs`, `interview/asr_trait.rs`

- 定义 `AsrEngine` trait（start/transcribe/vad/shutdown）
- 定义 JSON 协议类型（InMessage/OutMessage）
- 注册 `Cargo.toml` 依赖

### 步骤② 硬件探测 + 引擎选择

**文件**: `interview/engine_selector.rs`

- `detect_cuda()` → 调用 nvml-wrapper 或解析 nvidia-smi
- `detect_metal()` → sysctl machdep 检测 Apple Silicon
- `detect_vulkan()` → 检查 whisper-cli 二进制能否用 --vulkan 启动
- `select_engine()` → 按优先级返回 EngineConfig { engine, backend, model }
- Tauri 命令: `detect_interview_hardware()` → 返回可用引擎列表

### 步骤③ faster-whisper 引擎实现（Python 子进程）

**文件**: `interview/faster_whisper.rs`, `scripts/interview_asr.py`

- Python sidecar: 长期运行子进程，加载 faster-whisper 模型
- Rust: 管理 Python 进程生命周期，JSON Lines 通信
- 用户已有 Python + pip，auto-install 已在 InterviewRuntimeSection 中设计

### 步骤④ whisper.cpp 引擎实现（C++ 子进程）

**文件**: `interview/whisper_cpp.rs`

- 编译 whisper.cpp 生成 `whisper-cli` 二进制（构建时）
- 打包到 Tauri bundle resources
- 首次运行检测模型是否存在，不存在则下载 GGML 文件
- Rust: 管理 `whisper-cli` 进程生命周期
- 模型下载进度通过 `progress` 事件发射

### 步骤⑤ Tauri 命令注册

**文件**: `src-tauri/src/lib.rs`

```rust
// 新增 5 个命令:
#[tauri::command] interview_detect_hardware() -> Vec<EngineInfo>
#[tauri::command] interview_start_asr(state, engine_id: String, model: String)
#[tauri::command] interview_send_audio(state, chunk_id: String, wav_base64: String)
#[tauri::command] interview_stop_asr(state)
#[tauri::command] interview_generate_answer(state, question: String, session_id: String)
```

### 步骤⑥ 前端音频采集 + 端到端接线

**文件**: `src/hooks/useAudioCapture.ts`, `src/lib/tauri-bridge.ts`

- `useAudioCapture`: getUserMedia → MediaRecorder (500ms 分块) → WebM → WAV → base64
- 接入 `InterviewPanel`: 开始按钮触发 start → 音频块调用 invoke → 转录更新 store → 问题检测触发答案生成
- 答案生成复用现有 Claude CLI 管道（`useStreamProcessor` 监听）

---

## 八、依赖总结

```
Rust (Cargo.toml 新增):
  base64 = "0.22"        # 解码前端音频
  sysinfo = "0.31"       # CPU/GPU 硬件探测
  nvml-wrapper = "0.10"  # NVIDIA 显存查询 (可选)

Python (用户端 auto-install):
  faster-whisper         # CUDA 引擎
  silero-vad              # VAD 检测
  soundfile + numpy       # 音频处理

C++ (打包二进制):
  whisper.cpp            # 预编译 whisper-cli
  GGML 模型文件            # 运行时自动下载
```

---

## 九、就绪确认

- ✅ 无论用户是 CPU、核显、独显，都能运行
- ✅ 自动检测硬件、自动选引擎、自动下载模型
- ✅ 用户可在设置中手动覆盖引擎选择
- ✅ Audio 采集纯前端，无需额外权限
- ✅ 答案生成复用现有 Claude CLI 基础设施

**等待指令，从步骤①开始执行。**
