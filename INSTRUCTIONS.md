# 📖 Antigravity Kanban & Ralph Loop — Operational Instructions & Guide

Welcome to the comprehensive operational guide for **Antigravity Kanban & Ralph Loop**. This document explains how to configure, operate, and maximize productivity using the Kanban board and autonomous TDD Ralph Looping Agent in the **Antigravity Code Editor** and **VS Code**.

---

## 📑 Table of Contents

1. [Introduction & Architecture](#1-introduction--architecture)
2. [Installation & Setup](#2-installation--setup)
3. [Interface & Navigation](#3-interface--navigation)
4. [Configuring Models & API Credentials](#4-configuring-models--api-credentials)
5. [Task & Story Management](#5-task--story-management)
6. [Operating the Autonomous Ralph Loop](#6-operating-the-autonomous-ralph-loop)
7. [Terminal CLI Agent Integration](#7-terminal-cli-agent-integration)
8. [Multi-Project & Monorepo Support](#8-multi-project--monorepo-support)
9. [Building, Packaging & Releasing (.vsix)](#9-building-packaging--releasing-vsix)
10. [Troubleshooting & FAQs](#10-troubleshooting--faqs)

---

## 1. Introduction & Architecture

### Dual-Format Synchronization

Antigravity Kanban operates directly on files inside the `.antigravity/` folder in your workspace root:

```
your-project/
├── .antigravity/
│   ├── kanban.json    <-- Machine-readable state machine (AI agents, webview)
│   └── KANBAN.md      <-- Human-readable Markdown documentation (Git-tracked)
```

- **`kanban.json`**: Contains full JSON state including task columns, iteration counters, features, sub-stories, acceptance criteria, and execution telemetry logs.
- **`KANBAN.md`**: Automatically generated Markdown file displaying current task columns, checkboxes, priority tags, and history logs.
- **Bi-Directional Sync:** A file system watcher continuously monitors both files. If an external AI assistant (such as Antigravity, Claude Code, Cursor, or Aider) edits either file, the Kanban board automatically updates without requiring a manual reload.

---

## 2. Installation & Setup

### Prerequisites
- VS Code version `1.85.0` or higher, or **Antigravity Code Editor**.
- Node.js `20.x` or higher (only if building from source).

### Method A: Install Pre-built `.vsix` via VS Code UI

1. Download the latest `.vsix` package from the [GitHub Releases](https://github.com/warriorwizard/RalphLoop/releases).
2. Open VS Code or Antigravity IDE.
3. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
4. Type and select: **Extensions: Install from VSIX...**
5. Select the downloaded `.vsix` file.
6. The extension activates immediately.

### Method B: Install via Command Line

```bash
# Using VS Code CLI
code --install-extension RalphLoop-1.0.0.vsix

# Or in Antigravity IDE terminal
agy --install-extension RalphLoop-1.0.0.vsix
```

---

## 3. Interface & Navigation

### 1. Full Editor Kanban Board (`Ctrl+Alt+K` / `Cmd+Alt+K`)
Opens a full-featured webview tab in your main editor area:
- **Columns:** Queue (`pending`), Running (`in_progress`), and Completed (`done`) (with support for Backlog, To Do, and In Review).
- **Drag-and-Drop:** Drag cards between columns to change status.
- **Top HUD:**
  - Active Project Dropdown
  - Model Selector (Antigravity Native, Cloud APIs, Ollama, Terminal)
  - Execution Mode Selector (Planning, Fast, Pseudo-Ralph, Antigravity, Direct API, Terminal)
  - Ralph Loop Controls: **▶ Start Loop**, **⏸ Pause**, **⏹ Stop**
  - **+ New Task** button
  - **⚙ Settings** modal button
  - Search input and Feature/Priority filter pills.
- **Live Telemetry Drawer:** Toggle the bottom drawer to view streaming agent thoughts, tool calls, and test outputs.

### 2. Activity Bar Sidebar
Click the **Antigravity Kanban** icon in the activity bar:
- Displays task counts for Queue, Running, and Completed.
- Shows the currently running Ralph task.
- Provides quick action buttons to Open Board, Start Loop, Pause, and Refresh.

### 3. Status Bar Indicator
Located in the bottom status bar:
- `Ralph Idle` when no tasks are running.
- `Ralph: [TASK-001]` with a spin indicator when a task is executing.
- `Ralph: Verifying...` when the verification command is being evaluated.
- Click the status bar item anytime to focus the Kanban board.

---

## 4. Configuring Models & API Credentials

Click **⚙ Settings** in the Kanban board top HUD or open VS Code Settings (`Ctrl+,` -> Search `Antigravity Kanban`).

### Supported Providers & Setup

| Provider | Storage Method | Environment Variable Fallback |
|---|---|---|
| **Antigravity Native** | Built-in | None needed (uses Antigravity session) |
| **Anthropic (Claude)** | UI Settings (SecretStorage) | `ANTHROPIC_API_KEY` |
| **OpenAI (GPT-4o)** | UI Settings (SecretStorage) | `OPENAI_API_KEY` |
| **Google AI Studio** | UI Settings (SecretStorage) | `GEMINI_API_KEY` |
| **DeepSeek API** | UI Settings (SecretStorage) | `DEEPSEEK_API_KEY` |
| **Ollama (Local)** | Config endpoint (default: `http://127.0.0.1:11434`) | None needed |
| **Custom OpenAI-Compatible** | Base URL in settings | Compatible API key in SecretStorage |

> **Security Note:** Keys entered through the **⚙ Settings** dialog are stored in VS Code's encrypted native `SecretStorage` vault and never written to plain-text files or committed to Git.

### Setting Up Local Ollama
To run completely offline with private open-weights models:
1. Install [Ollama](https://ollama.ai) and pull your preferred model:
   ```bash
   ollama pull qwen2.5-coder:14b
   # or
   ollama pull deepseek-r1:14b
   ```
2. In Antigravity Kanban Settings, verify the Ollama endpoint:
   ```json
   "antigravityKanban.ollamaEndpoint": "http://127.0.0.1:11434"
   ```
3. Select `Ollama Local` from the top HUD model dropdown.

---

## 5. Task & Story Management

### Creating a Task

1. Click **+ New Task** in the top HUD or press `Ctrl+Shift+P` -> `Antigravity Kanban: Add Task`.
2. Fill in the task details:
   - **Title**: Descriptive name of the task.
   - **Description**: Detailed context, requirements, and files involved.
   - **Type**: `task`, `story`, `bug`, or `feature`.
   - **Priority**: `urgent`, `high`, `medium`, or `low`.
   - **Feature**: Link the card to an Epic/Feature for grouped tracking.
   - **Verification Command**: The automated test command Ralph will execute (e.g., `npm test -- tests/auth.spec.ts` or `pytest -k test_login`).
   - **Acceptance Criteria**: One criterion per line. Each criterion gets an interactive checkbox.
   - **Sub-stories**: Smaller sub-tasks, each with optional individual verification commands.

### Direct Markdown Editing

You can also edit `.antigravity/KANBAN.md` directly in your text editor:
```markdown
## Queue
- [ ] **[TASK-001]** Implement user authentication
  - Priority: high
  - Verification: `npm test -- auth`
  - [ ] Implement JWT token generator
  - [ ] Add refresh token rotation
```
Upon saving `KANBAN.md`, the visual board updates instantly.

---

## 6. Operating the Autonomous Ralph Loop

The **Ralph Loop** runs autonomous Test-Driven Development (TDD) cycles:

### The 5-Step Execution Cycle

1. **Task Selection:** Ralph scans the board for the first available card in **To Do / Queue** (or continues an **In Progress** card).
2. **Context Formulation:** Ralph extracts the task title, description, acceptance criteria, sub-stories, and recent workspace context into a targeted prompt.
3. **Model Dispatch:** The selected model (Antigravity Native, Claude 3.7, GPT-4o, DeepSeek, or Ollama) processes the prompt and applies necessary code edits.
4. **Automated Verification:** The extension runs the configured **verification command** in a child process.
5. **Outcome Evaluation:**
   - **Exit Code 0 (Success):** All acceptance criteria are marked completed, card logs record test success, and the card moves to **Completed / Done**.
   - **Exit Code Non-Zero (Failure):** Test output and stderr are appended to the card's execution logs and fed back into the model on the next iteration for self-correction.
   - **Iteration Limit:** If failures persist up to `maxIterations` (default: 5), Ralph pauses the loop and prompts the user for intervention.
   - **Auto-Advance:** When enabled, Ralph automatically selects the next task in the queue upon success.

### Loop Controls

- **▶ Start Ralph Loop:** Begins autonomous execution on the queue.
- **⏸ Pause Ralph Loop:** Gracefully pauses after the current iteration completes.
- **⏹ Stop Ralph Loop:** Immediately terminates active execution and child processes.

---

## 7. Terminal CLI Agent Integration

When setting **Model** or **Execution Mode** to `Terminal CLI Agent`:
- Ralph routes task prompts directly into an interactive terminal instance inside VS Code or Antigravity IDE.
- Ideal when pairing with CLI tools such as:
  - `aider`
  - `claude` (Claude Code)
  - `goose`
  - Custom shell agent scripts
- Ralph outputs the structured prompt into the terminal buffer and waits for terminal process completion before triggering verification.

---

## 8. Multi-Project & Monorepo Support

When working in multi-root workspaces or monorepos:
1. Open the Kanban board.
2. The top-left dropdown lists all detected projects and open workspace folders.
3. Switching the selection reloads `.antigravity/kanban.json` for that specific project root dynamically.

---

## 9. Building, Packaging & Releasing (.vsix)

### Local Development & Compilation

```bash
# 1. Install dependencies
npm ci

# 2. Compile TypeScript bundle using esbuild
npm run compile

# 3. Watch mode during development
npm run watch
```

### Packaging `.vsix` Locally

```bash
# Builds dist/ and creates antigravity-kanban-1.0.0.vsix
npm run package
```

### Automated GitHub Actions Release Workflow

This repository includes a fully automated GitHub Actions workflow (`.github/workflows/release.yml`):

1. **Tag-triggered release:**
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
2. GitHub Actions will automatically:
   - Check out code and set up Node 20.
   - Run clean dependency installation (`npm ci`).
   - Compile production bundles (`npm run compile`).
   - Package the `.vsix` extension file.
   - Create a GitHub Release with auto-generated release notes and the `.vsix` attached as a downloadable asset.
3. **Manual Trigger:** You can also trigger releases via **Actions -> Release VSIX -> Run workflow** on GitHub.

---

## 10. Troubleshooting & FAQs

### Q: The board shows empty or doesn't update.
- Ensure your workspace contains a valid `.antigravity/` directory. Click the **Reload from Disk** (`antigravity-kanban.refresh`) command or icon in the sidebar.

### Q: Verification command fails with "command not found".
- Ensure the verification tool (e.g., `npm`, `pytest`, `cargo`) is installed and available in your system `PATH`.
- In Windows, specify full commands such as `npm test` or `npx jest`.

### Q: How do I change the default verification command?
- In VS Code Settings (`Ctrl+,`), set `antigravityKanban.defaultVerificationCommand` to your preferred test suite (e.g., `npm test`). Individual cards can override this setting.

### Q: How do I safely reset the board?
- You can delete or edit `.antigravity/kanban.json` and `.antigravity/KANBAN.md`. Reload the window to reinitialize with clean default columns.

---

## 📄 Support & Community

- **Repository:** [https://github.com/warriorwizard/RalphLoop](https://github.com/warriorwizard/RalphLoop)
- **Issues & Feedback:** [https://github.com/warriorwizard/RalphLoop/issues](https://github.com/warriorwizard/RalphLoop/issues)
- **License:** MIT © 2026 warriorwizard / Proxomind Labs
