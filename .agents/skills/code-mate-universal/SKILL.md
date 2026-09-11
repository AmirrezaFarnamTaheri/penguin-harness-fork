---
name: code-mate-universal
description: Runs any external AI coding agent CLI (Antigravity, Claude Code, Codex, DeepSeek, Gemini, GitHub Copilot, Hermes, Kimi, OpenClaw, OpenCode, Pi, Qoder, Qwen) headlessly for repository analysis, benchmark comparison, or delegated coding tasks.
---

# Code Mate Universal CLI Runner

Execute headless tasks using any installed AI coding agent CLI adapter with unified arguments, strict timeouts, automated output parsing, and permission boundary guards.

## Supported Targets & Executables

| Target (`--target`) | Binary | Default Timeout | Notes |
| :--- | :--- | :--- | :--- |
| `antigravity` | `agy` | 10m | Google Antigravity CLI |
| `claude-code` | `claude` | 10m | Anthropic Claude Code CLI |
| `codex` | `codex` | 10m | OpenAI Codex CLI runtime |
| `deepseek` | `deepseek` | 10m | DeepSeek Harness CLI |
| `gemini` | `gemini` | 10m | Google Gemini Companion CLI |
| `copilot` | `copilot` | 10m | GitHub Copilot CLI |
| `hermes` | `hermes` | 10m | Nous Hermes Agent CLI |
| `kimi` | `kimi` | 10m | Moonshot Kimi Code CLI |
| `openclaw` | `openclaw` | 10m | OpenClaw Gateway CLI |
| `opencode` | `opencode` | 10m | OpenCode Runtime CLI |
| `pi` | `pi` | 10m | Pi Agent CLI |
| `qoder` | `qoder` | 10m | Qoder Agent CLI |
| `qwen` | `qwen` | 10m | Alibaba Qwen-Code CLI |

## Execution Workflow

1. **Verify Target Availability**:
   Check if the target binary is installed:
   ```bash
   command -v <binary> # e.g. agy, claude, codex, gemini
   ```
   If missing, halt immediately and notify the user to install the requested CLI tool.

2. **Run Headless Execution**:
   ```bash
   <binary> -p "<prompt>" --output-format json
   ```
   - Pass prompt as a single quoted argument.
   - Enforce an explicit timeout (default: 10 minutes).
   - If calling in print mode, set `--print-timeout 5m`.

3. **Output Validation & Error Handling**:
   - Parse stdout as JSON and inspect the `status` field.
   - Treat any non-zero exit code or missing `status: "OK"` / `"success"` as a failure.
   - Surface error reasons from the `error` or `message` property.
   - Never initiate interactive browser logins or authentication flows in automated pipelines.

## Security & Permission Boundaries

- Headless sessions inherit user permission configurations.
- Default file writes should only be permitted if the user explicitly requested mutating work in the target repository.
- Never pass dangerous bypass flags (e.g. `--dangerously-skip-permissions`).
- Always run a `git diff` review immediately after target execution to verify modified state against task specifications.
