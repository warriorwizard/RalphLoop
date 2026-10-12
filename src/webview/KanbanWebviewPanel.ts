import * as vscode from 'vscode';
import * as path from 'path';
import { FileManager } from '../storage/FileManager';
import { RalphLoopEngine, RalphTelemetryEvent } from '../engine/RalphLoopEngine';
import { KanbanBoard, KanbanCard, ColumnId, AVAILABLE_MODELS, RalphLoopStatus } from '../types/kanban';

export class KanbanWebviewPanel {
  public static currentPanel: KanbanWebviewPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly fileManager: FileManager;
  private readonly ralphEngine: RalphLoopEngine;
  private readonly secretStorage: vscode.SecretStorage;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(
    extensionUri: vscode.Uri,
    fileManager: FileManager,
    ralphEngine: RalphLoopEngine,
    secretStorage: vscode.SecretStorage
  ): KanbanWebviewPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (KanbanWebviewPanel.currentPanel) {
      KanbanWebviewPanel.currentPanel.panel.reveal(column);
      return KanbanWebviewPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'antigravityKanbanBoard',
      'Antigravity Kanban',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    KanbanWebviewPanel.currentPanel = new KanbanWebviewPanel(
      panel,
      extensionUri,
      fileManager,
      ralphEngine,
      secretStorage
    );

    return KanbanWebviewPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    fileManager: FileManager,
    ralphEngine: RalphLoopEngine,
    secretStorage: vscode.SecretStorage
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.fileManager = fileManager;
    this.ralphEngine = ralphEngine;
    this.secretStorage = secretStorage;

    this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'kanban-icon.svg');

    // Listen to messages from Webview BEFORE setting HTML so no early messages are missed
    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables
    );

    // Set HTML content
    this.panel.webview.html = this.getHtmlForWebview();

    // Listen to board updates from fileManager (e.g. external edits by AI agent in KANBAN.md or kanban.json)
    this.fileManager.onBoardChanged(
      (board) => {
        const currentProjectPath = this.fileManager.getWorkspaceRoot();
        const projects = FileManager.getWorkspaceProjects(currentProjectPath);
        this.postMessage({ type: 'syncBoard', board, projects, currentProjectPath });
      },
      null,
      this.disposables
    );

    // Listen to Ralph Engine telemetry events
    this.ralphEngine.onTelemetry(
      (event: RalphTelemetryEvent) => {
        this.postMessage({ type: 'ralphTelemetry', event });
      },
      null,
      this.disposables
    );

    // Listen to Ralph status changes
    this.ralphEngine.onStatusChange(
      (status: RalphLoopStatus) => {
        this.postMessage({
          type: 'ralphStatus',
          status,
          activeCard: this.ralphEngine.getActiveCard()
        });
      },
      null,
      this.disposables
    );

    // Proactively push initial data immediately
    this.handleMessage({ type: 'requestInitialData' });

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async handleMessage(message: any): Promise<void> {
    try {
      switch (message.type) {
        case 'requestInitialData': {
          const board = await this.fileManager.loadBoard();
          const currentProjectPath = this.fileManager.getWorkspaceRoot();
          const projects = FileManager.getWorkspaceProjects(currentProjectPath);
          const availableModels = await this.ralphEngine.getAvailableModels();
          const hasAnthropic = !!(await this.secretStorage.get('anthropicApiKey')) || !!process.env.ANTHROPIC_API_KEY;
          const hasOpenAi = !!(await this.secretStorage.get('openaiApiKey')) || !!process.env.OPENAI_API_KEY;
          const hasGemini = !!(await this.secretStorage.get('geminiApiKey')) || !!process.env.GEMINI_API_KEY;
          const hasDeepSeek = !!(await this.secretStorage.get('deepseekApiKey')) || !!process.env.DEEPSEEK_API_KEY;

          this.postMessage({
            type: 'syncBoard',
            board,
            projects,
            currentProjectPath,
            apiKeysStatus: { hasAnthropic, hasOpenAi, hasGemini, hasDeepSeek },
            availableModels,
            ralphStatus: this.ralphEngine.getStatus(),
            activeCard: this.ralphEngine.getActiveCard()
          });
          break;
        }

        case 'switchProject': {
          const newPath = message.projectPath;
          if (newPath) {
            const board = await this.fileManager.setWorkspaceRoot(newPath);
            this.ralphEngine.setWorkspaceRoot(newPath);
            const projects = FileManager.getWorkspaceProjects(newPath);
            const availableModels = await this.ralphEngine.getAvailableModels();
            this.postMessage({
              type: 'syncBoard',
              board,
              projects,
              currentProjectPath: newPath,
              availableModels,
              ralphStatus: this.ralphEngine.getStatus(),
              activeCard: this.ralphEngine.getActiveCard()
            });
            vscode.window.showInformationMessage(`Switched Kanban to ${path.basename(newPath)}`);
          }
          break;
        }

      case 'saveBoard': {
        try {
          await this.fileManager.saveBoard(message.board);
          vscode.window.setStatusBarMessage('Kanban saved to .antigravity/kanban.json & KANBAN.md', 2000);
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to save Kanban: ${err.message || err}`);
        }
        break;
      }

              case 'sendToChat': {
          try {
            const board = await this.fileManager.loadBoard();
            let card: KanbanCard | undefined;
            if (message.cardId) {
              card = board.cards.find(c => c.id === message.cardId);
            }
            if (!card) {
              card = board.cards.find(c => c.columnId === 'in_progress') || board.cards.find(c => c.columnId === 'pending' || c.columnId === 'todo');
            }
            if (!card) {
              vscode.window.showInformationMessage('No active or pending tasks in Queue to send to Antigravity Chat.');
              break;
            }

            // Stage task files in docs/tasks/
            await this.ralphEngine.stageTaskForAgent(card, board);

            // Move to in_progress if currently in pending
            if (card.columnId === 'pending' || card.columnId === 'todo') {
              card.columnId = 'in_progress';
              card.updatedAt = new Date().toISOString();
              await this.fileManager.saveBoard(board);
              this.postMessage({
                type: 'syncBoard',
                board,
                currentProjectPath: this.fileManager.getWorkspaceRoot()
              });
            }

            const promptQuery = `/ralph Execute task [${card.id}]: "${card.title}"`;
            try {
              await vscode.env.clipboard.writeText(promptQuery);
            } catch (_) {}

            // Try opening chat safely without throwing error if command doesn't exist
            try {
              await vscode.commands.executeCommand('workbench.action.openChat');
            } catch (_) {
              try {
                await vscode.commands.executeCommand('workbench.action.chat.open');
              } catch (_) {}
            }

            vscode.window.showInformationMessage(`[ralph] Task [${card.id}] staged! Switched to Chat — type /ralph to run.`);
          } catch (chatErr: any) {
            vscode.window.showErrorMessage(`Failed to bridge to Chat: ${chatErr.message || chatErr}`);
          }
          break;
        }

      case 'startRalphLoop': {
        await this.ralphEngine.startLoop(message.cardId);
        break;
      }

      case 'pauseRalphLoop': {
        this.ralphEngine.pauseLoop();
        break;
      }

      case 'stopRalphLoop': {
        this.ralphEngine.stopLoop();
        break;
      }

      case 'saveApiKeys': {
        const { anthropic, openai, gemini, deepseek } = message.keys || {};
        if (anthropic !== undefined && anthropic !== '') {
          await this.secretStorage.store('anthropicApiKey', anthropic);
        }
        if (openai !== undefined && openai !== '') {
          await this.secretStorage.store('openaiApiKey', openai);
        }
        if (gemini !== undefined && gemini !== '') {
          await this.secretStorage.store('geminiApiKey', gemini);
        }
        if (deepseek !== undefined && deepseek !== '') {
          await this.secretStorage.store('deepseekApiKey', deepseek);
        }
        vscode.window.showInformationMessage('Antigravity Kanban: API Keys securely saved.');
        this.handleMessage({ type: 'requestInitialData' });
        break;
      }

      case 'reloadFromDisk': {
        const board = await this.fileManager.loadBoard();
        const currentProjectPath = this.fileManager.getWorkspaceRoot();
        const projects = FileManager.getWorkspaceProjects(currentProjectPath);
        const availableModels = await this.ralphEngine.getAvailableModels();
        this.postMessage({ type: 'syncBoard', board, projects, currentProjectPath, availableModels });
        vscode.window.showInformationMessage('Board reloaded from workspace files.');
        break;
      }
    }
    } catch (err) {
      console.error('Error handling webview message:', err);
    }
  }

  private postMessage(msg: any): void {
    if (this.panel && this.panel.webview) {
      this.panel.webview.postMessage(msg);
    }
  }

  public dispose(): void {
    KanbanWebviewPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }

  private getHtmlForWebview(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Antigravity Kanban</title>
  <style>
    :root {
      --bg-base: #0f1117;
      --bg-subtle: #161821;
      --bg-card: #1c1e28;
      --bg-card-hover: #222532;
      --border-subtle: rgba(255, 255, 255, 0.08);
      --border-hover: rgba(255, 255, 255, 0.16);
      --border-focus: #3b82f6;
      --text-main: #f1f5f9;
      --text-secondary: #94a3b8;
      --text-muted: #64748b;
      --accent: #3b82f6;
      --accent-hover: #60a5fa;
      --danger: #ef4444;
      --warning: #f59e0b;
      --success: #10b981;
      --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif;
      --font-mono: 'JetBrains Mono', 'SF Mono', Consolas, monospace;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg-base);
      color: var(--text-main);
      font-family: var(--font-sans);
      font-size: 13px;
      line-height: 1.5;
      height: 100vh;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      -webkit-font-smoothing: antialiased;
    }

    /* Top HUD */
    .top-header {
      background-color: var(--bg-subtle);
      border-bottom: 1px solid var(--border-subtle);
      padding: 8px 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      z-index: 10;
    }

    .brand-section {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .brand-icon {
      width: 20px;
      height: 20px;
      color: #94a3b8;
    }

    .brand-title {
      font-size: 13px;
      font-weight: 600;
      letter-spacing: -0.01em;
      color: var(--text-main);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .brand-badge {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 3px;
      background: rgba(59, 130, 246, 0.12);
      color: #60a5fa;
      border: 1px solid rgba(59, 130, 246, 0.25);
      font-weight: 600;
      text-transform: uppercase;
      font-family: var(--font-mono);
    }

    .project-selector-wrapper {
      display: flex;
      align-items: center;
      gap: 6px;
      background: var(--bg-base);
      border: 1px solid var(--border-subtle);
      border-radius: 4px;
      padding: 2px 8px;
    }

    .project-selector-wrapper svg {
      width: 14px;
      height: 14px;
      color: var(--text-muted);
    }

    .select-dropdown {
      background: transparent;
      border: none;
      color: var(--text-main);
      padding: 4px 6px;
      font-size: 12px;
      outline: none;
      cursor: pointer;
    }

    .select-dropdown option, .select-dropdown optgroup {
      background: #1c1e28;
      color: #f1f5f9;
    }

    /* Ralph Controls */
    .ralph-controls {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .control-box {
      display: flex;
      align-items: center;
      gap: 8px;
      background: var(--bg-base);
      padding: 3px 8px;
      border-radius: 4px;
      border: 1px solid var(--border-subtle);
    }

    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 2px 8px;
      border-radius: 3px;
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.04em;
      font-family: var(--font-mono);
      text-transform: uppercase;
    }

    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
    }

    .status-pill.idle { background: rgba(100, 116, 139, 0.15); color: #94a3b8; }
    .status-pill.idle .status-dot { background: #64748b; }
    .status-pill.running { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }
    .status-pill.running .status-dot { background: #f59e0b; box-shadow: 0 0 8px #f59e0b; }
    .status-pill.verifying { background: rgba(59, 130, 246, 0.15); color: #60a5fa; }
    .status-pill.verifying .status-dot { background: #3b82f6; box-shadow: 0 0 8px #3b82f6; }
    .status-pill.completed { background: rgba(16, 185, 129, 0.15); color: #34d399; }
    .status-pill.completed .status-dot { background: #10b981; }
    .status-pill.paused { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }
    .status-pill.paused .status-dot { background: #fbbf24; }

    /* Action Buttons */
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 11px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid var(--border-subtle);
      background: var(--bg-card);
      color: var(--text-main);
      transition: all 0.12s ease;
      font-family: inherit;
    }

    .btn:hover {
      background: var(--bg-card-hover);
      border-color: var(--border-hover);
    }

    .btn-primary {
      background: #2563eb;
      border-color: #3b82f6;
      color: #ffffff;
    }

    .btn-primary:hover {
      background: #1d4ed8;
      border-color: #60a5fa;
    }

    .btn-danger {
      background: rgba(239, 68, 68, 0.12);
      border-color: rgba(239, 68, 68, 0.35);
      color: #f87171;
    }

    .btn-danger:hover {
      background: rgba(239, 68, 68, 0.25);
    }

    .btn svg {
      width: 13px;
      height: 13px;
    }

    /* Sub-Toolbar */
    .sub-toolbar {
      padding: 8px 16px;
      background: var(--bg-subtle);
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }

    .search-group {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 1;
      max-width: 440px;
    }

    .search-box {
      display: flex;
      align-items: center;
      gap: 8px;
      background: var(--bg-base);
      border: 1px solid var(--border-subtle);
      border-radius: 4px;
      padding: 4px 10px;
      width: 100%;
    }

    .search-box svg {
      width: 13px;
      height: 13px;
      color: var(--text-muted);
    }

    .search-input {
      background: transparent;
      border: none;
      color: var(--text-main);
      font-size: 12px;
      width: 100%;
      outline: none;
    }

    /* 3-Column Kanban Board */
    .kanban-board {
      flex: 1;
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 14px;
      padding: 14px 16px;
      overflow-x: auto;
      overflow-y: hidden;
    }

    .kanban-column {
      background: var(--bg-subtle);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      display: flex;
      flex-direction: column;
      max-height: 100%;
      overflow: hidden;
    }

    .column-header {
      padding: 10px 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border-subtle);
      background: rgba(255, 255, 255, 0.02);
    }

    .column-title-group {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12.5px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }

    .column-counter {
      font-family: var(--font-mono);
      font-size: 11px;
      padding: 1px 6px;
      border-radius: 3px;
      background: var(--bg-base);
      border: 1px solid var(--border-subtle);
      color: var(--text-muted);
    }

    .column-cards-container {
      flex: 1;
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-height: 120px;
    }

    .column-cards-container.dragover {
      background: rgba(59, 130, 246, 0.04);
      border: 1px dashed rgba(59, 130, 246, 0.4);
      border-radius: 4px;
    }

    /* Task Card */
    .kanban-card {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: 5px;
      padding: 10px 12px;
      cursor: grab;
      display: flex;
      flex-direction: column;
      gap: 7px;
      transition: border-color 0.12s, box-shadow 0.12s;
    }

    .kanban-card:hover {
      border-color: var(--border-hover);
      box-shadow: 0 3px 8px rgba(0, 0, 0, 0.25);
    }

    .kanban-card.active-ralph {
      border-color: var(--warning);
      box-shadow: 0 0 10px rgba(245, 158, 11, 0.15);
    }

    .card-top-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .card-id {
      font-family: var(--font-mono);
      font-size: 10.5px;
      font-weight: 600;
      color: var(--text-muted);
    }

    .priority-badge {
      font-size: 9.5px;
      font-weight: 600;
      text-transform: uppercase;
      padding: 1px 5px;
      border-radius: 2px;
      font-family: var(--font-mono);
      border: 1px solid transparent;
    }

    .priority-urgent { background: rgba(239, 68, 68, 0.12); color: #f87171; border-color: rgba(239, 68, 68, 0.25); }
    .priority-high { background: rgba(245, 158, 11, 0.12); color: #fbbf24; border-color: rgba(245, 158, 11, 0.25); }
    .priority-medium { background: rgba(59, 130, 246, 0.12); color: #60a5fa; border-color: rgba(59, 130, 246, 0.25); }
    .priority-low { background: rgba(100, 116, 139, 0.12); color: #94a3b8; border-color: rgba(100, 116, 139, 0.25); }

    .card-title {
      font-size: 12.5px;
      font-weight: 600;
      color: var(--text-main);
      line-height: 1.35;
    }

    .card-desc {
      font-size: 11.5px;
      color: var(--text-secondary);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      line-height: 1.4;
    }

    .card-meta-row {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-top: 2px;
    }

    .meta-tag {
      background: var(--bg-base);
      border: 1px solid var(--border-subtle);
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 10px;
      color: var(--text-muted);
      font-family: var(--font-mono);
    }

    .meta-model {
      background: rgba(147, 51, 234, 0.1);
      border: 1px solid rgba(147, 51, 234, 0.25);
      color: #c084fc;
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 10px;
      font-family: var(--font-mono);
    }

    .meta-verify {
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.25);
      color: #34d399;
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 10px;
      font-family: var(--font-mono);
    }

    /* Features / Epics Bar */
    .features-bar {
      padding: 6px 16px;
      background: rgba(0, 0, 0, 0.25);
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      gap: 6px;
      align-items: center;
      overflow-x: auto;
      scrollbar-width: thin;
    }

    .feature-chip {
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-family: var(--font-mono);
      border: 1px solid var(--border-subtle);
      background: var(--bg-card);
      color: var(--text-secondary);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
      transition: all 0.12s ease;
      user-select: none;
    }

    .feature-chip:hover {
      background: var(--bg-card-hover);
      border-color: var(--border-hover);
      color: var(--text-main);
    }

    .feature-chip.active {
      background: rgba(59, 130, 246, 0.15);
      border-color: #3b82f6;
      color: #60a5fa;
      font-weight: 600;
    }

    .feature-chip .count-badge {
      font-size: 9px;
      padding: 1px 4px;
      border-radius: 2px;
      background: rgba(255, 255, 255, 0.08);
      color: var(--text-muted);
    }

    .feature-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
    }

    /* Sub-stories on Card */
    .card-substories {
      margin-top: 5px;
      padding: 6px 8px;
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid rgba(255, 255, 255, 0.04);
      border-radius: 4px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .substories-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 10px;
      color: var(--text-muted);
      font-family: var(--font-mono);
    }

    .substory-progress-bar {
      height: 3px;
      border-radius: 1.5px;
      background: rgba(255, 255, 255, 0.08);
      overflow: hidden;
      margin-top: 2px;
      margin-bottom: 2px;
    }

    .substory-progress-fill {
      height: 100%;
      background: #10b981;
      transition: width 0.2s ease;
    }

    .substory-list {
      display: flex;
      flex-direction: column;
      gap: 3px;
      margin-top: 3px;
    }

    .card-substory-row {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      font-size: 11px;
      color: var(--text-secondary);
      cursor: pointer;
      line-height: 1.3;
    }

    .card-substory-row input[type="checkbox"] {
      cursor: pointer;
      margin-top: 2px;
      accent-color: #3b82f6;
    }

    .card-substory-row.completed span {
      text-decoration: line-through;
      color: #64748b;
    }

    /* Meta Badges */
    .meta-feature {
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 9.5px;
      font-family: var(--font-mono);
      font-weight: 600;
      border: 1px solid currentColor;
      background: rgba(255, 255, 255, 0.03);
    }

    .meta-type {
      padding: 1px 5px;
      border-radius: 2px;
      font-size: 9.5px;
      font-family: var(--font-mono);
      font-weight: 700;
      text-transform: uppercase;
    }
    .meta-type.story { background: rgba(59, 130, 246, 0.12); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.25); }
    .meta-type.task { background: rgba(147, 51, 234, 0.12); color: #c084fc; border: 1px solid rgba(147, 51, 234, 0.25); }
    .meta-type.bug { background: rgba(239, 68, 68, 0.12); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.25); }

    .card-bottom-actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 4px;
      padding-top: 6px;
      border-top: 1px solid rgba(255, 255, 255, 0.04);
    }

    .card-action-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 11px;
      padding: 3px 6px;
      border-radius: 3px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .card-action-btn:hover {
      background: var(--bg-base);
      color: var(--text-main);
    }

    .card-action-btn svg {
      width: 12px;
      height: 12px;
    }

    /* Live Ralph Log Drawer */
    .log-drawer {
      height: 150px;
      background: #090a0f;
      border-top: 1px solid var(--border-subtle);
      display: flex;
      flex-direction: column;
      font-family: var(--font-mono);
      font-size: 11px;
    }

    .log-drawer-header {
      padding: 5px 14px;
      background: #11131a;
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: var(--text-muted);
      font-size: 11px;
    }

    .log-content {
      flex: 1;
      overflow-y: auto;
      padding: 8px 14px;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .log-entry {
      display: flex;
      gap: 8px;
      line-height: 1.4;
    }

    .log-time { color: #475569; }
    .log-type-info { color: #60a5fa; }
    .log-type-model { color: #c084fc; }
    .log-type-tool { color: #fbbf24; }
    .log-type-verify { color: #38bdf8; }
    .log-type-success { color: #34d399; font-weight: 600; }
    .log-type-error { color: #f87171; font-weight: 600; }

    /* Modal Backdrop */
    .modal-backdrop {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(2px);
      display: none;
      justify-content: center;
      align-items: center;
      z-index: 1000;
    }

    .modal-backdrop.open { display: flex; }

    .modal-box {
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      width: 500px;
      max-width: 95vw;
      max-height: 88vh;
      overflow-y: auto;
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.5);
      display: flex;
      flex-direction: column;
    }

    .modal-header {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border-subtle);
      font-size: 13.5px;
      font-weight: 600;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .modal-body {
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .form-group {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }

    .form-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.02em;
    }

    .form-input, .form-textarea, .form-select {
      background: var(--bg-base);
      border: 1px solid var(--border-subtle);
      color: var(--text-main);
      padding: 7px 10px;
      border-radius: 4px;
      font-family: inherit;
      font-size: 12.5px;
      outline: none;
    }

    .form-textarea {
      min-height: 75px;
      resize: vertical;
    }

    .form-input:focus, .form-textarea:focus, .form-select:focus {
      border-color: var(--border-focus);
    }

    .modal-footer {
      padding: 10px 16px;
      border-top: 1px solid var(--border-subtle);
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
  </style>
</head>
<body>

  <!-- Top Header HUD -->
  <header class="top-header">
    <div class="brand-section">
      <svg class="brand-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
        <rect x="3" y="3" width="18" height="18" rx="2" stroke="#64748b"/>
        <line x1="9" y1="3" x2="9" y2="21" stroke="#334155"/>
        <line x1="15" y1="3" x2="15" y2="21" stroke="#334155"/>
        <rect x="5" y="6" width="2.5" height="3" rx="0.5" fill="#38bdf8"/>
        <rect x="11" y="6" width="2.5" height="5" rx="0.5" fill="#f59e0b"/>
        <rect x="17" y="6" width="2.5" height="3" rx="0.5" fill="#10b981"/>
      </svg>
      <div class="brand-title">
        Antigravity Kanban
        <span class="brand-badge">Ralph Engine</span>
      </div>

      <!-- Project Switcher Dropdown -->
      <div class="project-selector-wrapper" title="Switch active workspace project">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        <select class="select-dropdown" id="projectSelectDropdown">
          <option value="">Loading projects...</option>
        </select>
      </div>
    </div>

    <!-- Ralph Loop Controls -->
    <div class="ralph-controls">
      <div class="control-box">
        <div class="status-pill idle" id="ralphStatusBadge">
          <span class="status-dot"></span>
          <span id="ralphStatusText">IDLE</span>
        </div>

        <select class="select-dropdown" id="modelSelectDropdown" title="Model for autonomous loop">
          <!-- Populated dynamically -->
        </select>

        <select class="select-dropdown" id="modeSelectDropdown" title="Antigravity Agent Mode">
          <optgroup label="Antigravity Native Modes">
            <option value="Planning" selected>Planning Mode (Deep Reasoning)</option>
            <option value="Fast">Fast Mode (Quick Execution)</option>
            <option value="Pseudo-Ralph">Pseudo Ralph (Persistent Cascade)</option>
          </optgroup>
          <optgroup label="Alternative Runners">
            <option value="direct-api">Direct API (BYOK)</option>
            <option value="terminal-agent">Terminal Agent (CLI)</option>
          </optgroup>
        </select>
      </div>

            <button class="btn btn-secondary" id="btnSendToChat" title="Send active task to Antigravity Chat Agent (/ralph)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <span>Send to Chat (/ralph)</span>
      </button>

      <button class="btn btn-primary" id="btnStartRalph" title="Start autonomous loop on Queue/Running tasks">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
        <span>Start Ralph</span>
      </button>

      <button class="btn" id="btnPauseRalph" title="Pause Loop" style="display: none;">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <rect x="6" y="4" width="4" height="16"/>
          <rect x="14" y="4" width="4" height="16"/>
        </svg>
        <span>Pause</span>
      </button>

      <button class="btn btn-danger" id="btnStopRalph" title="Halt Loop" style="display: none;">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <rect x="5" y="5" width="14" height="14" rx="1"/>
        </svg>
        <span>Stop</span>
      </button>

      <button class="btn" id="btnOpenSettings" title="API Keys & Engine Settings">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
        <span>Settings</span>
      </button>
    </div>
  </header>

  <!-- Sub-Toolbar (Search & Filters) -->
  <div class="sub-toolbar">
    <div class="search-group">
      <div class="search-box">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input type="text" class="search-input" id="searchFilterInput" placeholder="Filter stories, tags, IDs, features...">
      </div>

      <select class="select-dropdown" id="typeFilterSelect" style="border: 1px solid var(--border-subtle); border-radius: 4px; padding: 4px 8px; background: var(--bg-base);">
        <option value="all">All Types</option>
        <option value="story">Stories</option>
        <option value="task">Tasks</option>
        <option value="bug">Bugs</option>
      </select>

      <select class="select-dropdown" id="priorityFilterSelect" style="border: 1px solid var(--border-subtle); border-radius: 4px; padding: 4px 8px; background: var(--bg-base);">
        <option value="all">All Priorities</option>
        <option value="urgent">Urgent</option>
        <option value="high">High</option>
        <option value="medium">Medium</option>
        <option value="low">Low</option>
      </select>
    </div>

    <div style="display: flex; gap: 8px;">
      <button class="btn" id="btnManageFeatures" title="Manage Features / Epics">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="12 2 2 7 12 12 22 7 12 2"/>
          <polyline points="2 17 12 22 22 17"/>
          <polyline points="2 12 12 17 22 12"/>
        </svg>
        <span>Features (<span id="featuresCountBadge">0</span>)</span>
      </button>

      <button class="btn btn-primary" id="btnOpenNewCardModal">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        <span>New Story</span>
      </button>

      <button class="btn" id="btnReloadDisk" title="Synchronize from disk">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="23 4 23 10 17 10"/>
          <polyline points="1 20 1 14 7 14"/>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
        </svg>
        <span>Sync</span>
      </button>
    </div>
  </div>

  <!-- Features / Epics Navigation Bar -->
  <div class="features-bar" id="featuresBarContainer">
    <!-- Populated dynamically with feature filter pills, progress metrics, and '+ Feature' button -->
  </div>

  <!-- 3-Column Kanban Board -->
  <main class="kanban-board" id="kanbanBoardContainer">
    <!-- Columns and cards rendered dynamically -->
  </main>

  <!-- Live Ralph Log Drawer -->
  <footer class="log-drawer">
    <div class="log-drawer-header">
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="font-weight: 600;">Ralph Telemetry Stream</span>
        <span id="activeCardLabel" style="color: var(--warning);"></span>
      </div>
      <div>
        <button class="card-action-btn" id="btnClearLogs">Clear</button>
      </div>
    </div>
    <div class="log-content" id="logStreamContainer">
      <div class="log-entry">
        <span class="log-time">[System]</span>
        <span class="log-type-info">Kanban initialized. Synchronized with .antigravity/kanban.json and KANBAN.md.</span>
      </div>
    </div>
  </footer>

  <!-- Modal: Create / Edit Card -->
  <div class="modal-backdrop" id="cardModal">
    <div class="modal-box">
      <div class="modal-header">
        <span id="modalCardTitleHeading">Create Story</span>
        <button class="card-action-btn" id="btnCloseCardModal">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <input type="hidden" id="modalCardId">
        <div class="form-group">
          <label class="form-label">Title</label>
          <input type="text" class="form-input" id="modalCardTitleInput" placeholder="User story or task summary...">
        </div>
        <div class="form-group">
          <label class="form-label">Description (Context & Requirements)</label>
          <textarea class="form-textarea" id="modalCardDescInput" placeholder="As a developer / operator, I need..."></textarea>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          <div class="form-group">
            <label class="form-label">Feature / Epic</label>
            <select class="form-select" id="modalCardFeatureSelect">
              <option value="">No Feature (General)</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Item Type</label>
            <select class="form-select" id="modalCardTypeSelect">
              <option value="story" selected>User Story</option>
              <option value="task">Engineering Task</option>
              <option value="bug">Defect / Bug</option>
            </select>
          </div>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          <div class="form-group">
            <label class="form-label">Stage</label>
            <select class="form-select" id="modalCardColumnSelect">
              <option value="pending">Queue</option>
              <option value="in_progress">Running</option>
              <option value="done">Completed</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Priority</label>
            <select class="form-select" id="modalCardPrioritySelect">
              <option value="low">Low</option>
              <option value="medium" selected>Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>
        </div>
        <!-- Sub-Stories Section -->
        <div class="form-group">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <label class="form-label">Sub-Stories / Actionable Tasks</label>
            <button type="button" class="card-action-btn" id="btnAddSubStoryInput" style="color: #60a5fa; border: 1px solid rgba(59,130,246,0.3); padding: 2px 7px;">+ Add Sub-Story</button>
          </div>
          <div id="modalSubStoriesContainer" style="display: flex; flex-direction: column; gap: 6px; margin-top: 4px;"></div>
        </div>
        <div class="form-group">
          <label class="form-label">Tags (comma separated)</label>
          <input type="text" class="form-input" id="modalCardTagsInput" placeholder="architecture, bug, rust">
        </div>
        <div class="form-group">
          <label class="form-label">Model Override (optional)</label>
          <select class="form-select" id="modalCardModelSelect">
            <option value="">Use Default Model</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Verification Command (Automated Test)</label>
          <input type="text" class="form-input" id="modalCardVerifyInput" placeholder="e.g. npm test or cargo test">
        </div>
        <div class="form-group">
          <label class="form-label">Acceptance Criteria (one per line)</label>
          <textarea class="form-textarea" id="modalCardCriteriaInput" placeholder="- [ ] Compiles cleanly&#10;- [ ] All unit tests pass"></textarea>
        </div>
      </div>
      <div class="modal-footer" style="display: flex; justify-content: space-between; align-items: center;">
        <button class="btn btn-danger" id="btnDeleteCardModal" style="display: none;">Delete</button>
        <div style="display: flex; gap: 8px;">
          <button class="btn" id="btnCancelCardModal">Cancel</button>
          <button class="btn btn-primary" id="btnSaveCardModal">Save Story</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Modal: Features & Epics Manager -->
  <div class="modal-backdrop" id="featuresModal">
    <div class="modal-box" style="width: 620px;">
      <div class="modal-header">
        <span>Manage Features & Epics</span>
        <button class="card-action-btn" id="btnCloseFeaturesModal">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <div style="background: rgba(255, 255, 255, 0.02); border: 1px solid var(--border-subtle); border-radius: 4px; padding: 10px; display: flex; flex-direction: column; gap: 8px;">
          <span style="font-size: 11px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase;">Create Feature / Epic</span>
          <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 8px;">
            <input type="text" class="form-input" id="newFeatureTitleInput" placeholder="Feature title (e.g. Core WAL Substrate)...">
            <select class="form-select" id="newFeatureColorSelect">
              <option value="#3b82f6" selected>Blue</option>
              <option value="#10b981">Emerald</option>
              <option value="#8b5cf6">Purple</option>
              <option value="#f59e0b">Amber</option>
              <option value="#ec4899">Pink</option>
              <option value="#06b6d4">Cyan</option>
            </select>
          </div>
          <input type="text" class="form-input" id="newFeatureDescInput" placeholder="Short description / milestone objective (optional)...">
          <div style="display: flex; justify-content: flex-end;">
            <button class="btn btn-primary" id="btnCreateFeatureSubmit">+ Add Feature</button>
          </div>
        </div>

        <div style="margin-top: 8px;">
          <span style="font-size: 11px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase;">Features in Workspace</span>
          <div id="featuresListContainer" style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px; max-height: 250px; overflow-y: auto;">
            <!-- Rendered dynamically -->
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn" id="btnDoneFeaturesModal">Close</button>
      </div>
    </div>
  </div>

  <!-- Modal: Settings & API Keys -->
  <div class="modal-backdrop" id="settingsModal">
    <div class="modal-box">
      <div class="modal-header">
        <span>Settings & API Configuration</span>
        <button class="card-action-btn" id="btnCloseSettingsModal">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <div style="background: rgba(59, 130, 246, 0.08); border: 1px solid rgba(59, 130, 246, 0.2); border-radius: 4px; padding: 8px 12px; font-size: 11.5px; line-height: 1.45; color: var(--text-main);">
          <strong>Antigravity Built-in Models:</strong> Models like <em>Claude Opus 4.6 (Thinking)</em>, <em>Claude Sonnet 4.6 (Thinking)</em>, and <em>Gemini 3.1 Pro</em> execute directly through Antigravity with <strong>no external API keys required</strong>.
        </div>
        <p style="font-size: 11px; color: var(--text-muted);">
          Optional external API keys are stored in secure credential storage.
        </p>
        <div class="form-group">
          <label class="form-label">Anthropic API Key</label>
          <input type="password" class="form-input" id="inputAnthropicKey" placeholder="sk-ant-...">
        </div>
        <div class="form-group">
          <label class="form-label">OpenAI API Key</label>
          <input type="password" class="form-input" id="inputOpenAiKey" placeholder="sk-proj-...">
        </div>
        <div class="form-group">
          <label class="form-label">Google Gemini API Key</label>
          <input type="password" class="form-input" id="inputGeminiKey" placeholder="AIzaSy...">
        </div>
        <div class="form-group">
          <label class="form-label">DeepSeek API Key</label>
          <input type="password" class="form-input" id="inputDeepSeekKey" placeholder="sk-...">
        </div>
        <div class="form-group">
          <label class="form-label">Ollama Endpoint URL</label>
          <input type="text" class="form-input" id="inputOllamaUrl" placeholder="http://127.0.0.1:11434">
        </div>
        <div class="form-group">
          <label class="form-label">Custom API Endpoint</label>
          <input type="text" class="form-input" id="inputCustomUrl" placeholder="https://api.deepseek.com/v1">
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn" id="btnCancelSettingsModal">Cancel</button>
        <button class="btn btn-primary" id="btnSaveSettingsModal">Save Settings</button>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    let currentBoard = null;
    let availableModels = [];
    let workspaceProjects = [];
    let currentProjectPath = '';
    let ralphStatus = 'idle';
    let activeCard = null;
    let activeFeatureFilter = 'all';
    let modalSubStories = [];

    // Elements
    const boardContainer = document.getElementById('kanbanBoardContainer');
    const projectDropdown = document.getElementById('projectSelectDropdown');
    const modelDropdown = document.getElementById('modelSelectDropdown');
    const modeDropdown = document.getElementById('modeSelectDropdown');
    const statusBadge = document.getElementById('ralphStatusBadge');
    const statusText = document.getElementById('ralphStatusText');
    const btnStart = document.getElementById('btnStartRalph');
    const btnPause = document.getElementById('btnPauseRalph');
    const btnStop = document.getElementById('btnStopRalph');
    const logContainer = document.getElementById('logStreamContainer');
    const activeCardLabel = document.getElementById('activeCardLabel');
    const featuresBar = document.getElementById('featuresBarContainer');
    const featuresCountBadge = document.getElementById('featuresCountBadge');
    const typeFilterSelect = document.getElementById('typeFilterSelect');
    const modalCardFeatureSelect = document.getElementById('modalCardFeatureSelect');
    const modalCardTypeSelect = document.getElementById('modalCardTypeSelect');
    const modalSubStoriesContainer = document.getElementById('modalSubStoriesContainer');

    // Modals
    const cardModal = document.getElementById('cardModal');
    const settingsModal = document.getElementById('settingsModal');
    const featuresModal = document.getElementById('featuresModal');

    // Initialize
    function requestInitial() {
      vscode.postMessage({ type: 'requestInitialData' });
    }
    if (document.readyState === 'loading') {
      window.addEventListener('DOMContentLoaded', requestInitial);
    } else {
      requestInitial();
    }
    // Safety retry if board hasn't been received after 500ms
    setTimeout(() => {
      if (!currentBoard) {
        requestInitial();
      }
    }, 500);

    // Handle messages from Extension
    window.addEventListener('message', (event) => {
      try {
        const msg = event.data;
        switch (msg.type) {
          case 'syncBoard': {
            if (!msg.board) return;
            currentBoard = msg.board;
            currentBoard.features = currentBoard.features || [];
            populateFeaturesBar();
            populateFeatureSelectDropdown();
            if (msg.projects && msg.projects.length > 0) {
              workspaceProjects = msg.projects;
              currentProjectPath = msg.currentProjectPath || currentProjectPath;
              populateProjectDropdown();
            } else if (msg.currentProjectPath) {
              workspaceProjects = [{ name: 'Current Project', path: msg.currentProjectPath }];
              currentProjectPath = msg.currentProjectPath;
              populateProjectDropdown();
            }
            if (msg.availableModels && msg.availableModels.length > 0) {
              availableModels = msg.availableModels;
              populateModelDropdowns();
            }
            if (msg.ralphStatus) {
              updateRalphStatus(msg.ralphStatus, msg.activeCard);
            }
            renderBoard();
            break;
          }
          case 'ralphStatus': {
            updateRalphStatus(msg.status, msg.activeCard);
            break;
          }
          case 'ralphTelemetry': {
            appendLogEntry(msg.event.log);
            if (msg.event.activeCardId) {
              activeCardLabel.innerText = '• ' + msg.event.activeCardId + ': ' + (msg.event.activeCardTitle || '');
            }
            break;
          }
        }
      } catch (err) {
        console.error('Error processing webview message:', err);
      }
    });

    function populateProjectDropdown() {
      projectDropdown.innerHTML = '';
      if (!workspaceProjects || workspaceProjects.length === 0) {
        const opt = document.createElement('option');
        opt.value = currentProjectPath;
        opt.innerText = currentProjectPath ? currentProjectPath.split(/[\\/]/).pop() : 'Default Project';
        opt.selected = true;
        projectDropdown.appendChild(opt);
        return;
      }
      workspaceProjects.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.path;
        opt.innerText = p.name || p.path.split(/[\\/]/).pop();
        if (p.path === currentProjectPath) {
          opt.selected = true;
        }
        projectDropdown.appendChild(opt);
      });
    }

    projectDropdown.addEventListener('change', () => {
      const selectedPath = projectDropdown.value;
      if (selectedPath) {
        vscode.postMessage({ type: 'switchProject', projectPath: selectedPath });
      }
    });

    function populateModelDropdowns() {
      modelDropdown.innerHTML = '';
      const modalSelect = document.getElementById('modalCardModelSelect');
      modalSelect.innerHTML = '<option value="">Use Default Model</option>';

      // Separate native Antigravity models vs external API models
      const nativeModels = availableModels.filter(m => m.isNative || m.provider === 'antigravity' || m.provider === 'antigravity-lm');
      const externalModels = availableModels.filter(m => !m.isNative && m.provider !== 'antigravity' && m.provider !== 'antigravity-lm');

      // Top Header Model Dropdown
      if (nativeModels.length > 0) {
        const groupNative = document.createElement('optgroup');
        groupNative.label = 'Antigravity Built-in Models';
        nativeModels.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.innerText = m.name;
          if (currentBoard && currentBoard.ralphConfig && currentBoard.ralphConfig.defaultModel === m.id) {
            opt.selected = true;
          }
          groupNative.appendChild(opt);
        });
        modelDropdown.appendChild(groupNative);
      }

      if (externalModels.length > 0) {
        const groupExt = document.createElement('optgroup');
        groupExt.label = 'External API Providers';
        externalModels.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.innerText = m.name;
          if (currentBoard && currentBoard.ralphConfig && currentBoard.ralphConfig.defaultModel === m.id) {
            opt.selected = true;
          }
          groupExt.appendChild(opt);
        });
        modelDropdown.appendChild(groupExt);
      }

      // Modal Card Select Dropdown
      if (nativeModels.length > 0) {
        const modalGroupNative = document.createElement('optgroup');
        modalGroupNative.label = 'Antigravity Built-in Models';
        nativeModels.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.innerText = m.name;
          modalGroupNative.appendChild(opt);
        });
        modalSelect.appendChild(modalGroupNative);
      }

      if (externalModels.length > 0) {
        const modalGroupExt = document.createElement('optgroup');
        modalGroupExt.label = 'External API Providers';
        externalModels.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.innerText = m.name;
          modalGroupExt.appendChild(opt);
        });
        modalSelect.appendChild(modalGroupExt);
      }

      if (currentBoard && currentBoard.ralphConfig) {
        if (currentBoard.ralphConfig.defaultModel) {
          modelDropdown.value = currentBoard.ralphConfig.defaultModel;
        } else if (nativeModels.length > 0) {
          modelDropdown.value = nativeModels[0].id;
        }
        const savedMode = currentBoard.ralphConfig.executionMode;
        modeDropdown.value = (savedMode === 'antigravity' ? 'Planning' : savedMode) || 'Planning';
      } else if (nativeModels.length > 0) {
        modelDropdown.value = nativeModels[0].id;
        modeDropdown.value = 'Planning';
      }
    }

    function populateFeaturesBar() {
      if (!currentBoard) return;
      featuresBar.innerHTML = '';

      const totalCards = currentBoard.cards.length;
      featuresCountBadge.innerText = (currentBoard.features || []).length;

      // 'All Features' pill
      const allPill = document.createElement('div');
      allPill.className = 'feature-chip' + (activeFeatureFilter === 'all' ? ' active' : '');
      allPill.innerHTML = \`
        <span>All Features</span>
        <span class="feature-count-badge">\${totalCards}</span>
      \`;
      allPill.onclick = () => {
        activeFeatureFilter = 'all';
        populateFeaturesBar();
        renderBoard();
      };
      featuresBar.appendChild(allPill);

      // Individual Feature pills
      (currentBoard.features || []).forEach(f => {
        const fCards = currentBoard.cards.filter(c => c.featureId === f.id);
        const doneCards = fCards.filter(c => c.columnId === 'done');
        const chip = document.createElement('div');
        chip.className = 'feature-chip' + (activeFeatureFilter === f.id ? ' active' : '');
        chip.innerHTML = \`
          <span class="feature-dot" style="background: \${f.color || '#3b82f6'};"></span>
          <span>\${escapeHtml(f.title)}</span>
          <span class="feature-count-badge">\${doneCards.length}/\${fCards.length}</span>
        \`;
        chip.onclick = () => {
          activeFeatureFilter = f.id;
          populateFeaturesBar();
          renderBoard();
        };
        featuresBar.appendChild(chip);
      });

      // '+ Feature' button
      const addBtn = document.createElement('button');
      addBtn.className = 'btn';
      addBtn.style.padding = '3px 8px';
      addBtn.style.fontSize = '11px';
      addBtn.style.height = '24px';
      addBtn.innerHTML = '+ Feature';
      addBtn.onclick = () => openFeaturesModal();
      featuresBar.appendChild(addBtn);
    }

    function populateFeatureSelectDropdown() {
      if (!currentBoard) return;
      modalCardFeatureSelect.innerHTML = '<option value="">No Feature (General)</option>';
      (currentBoard.features || []).forEach(f => {
        const opt = document.createElement('option');
        opt.value = f.id;
        opt.innerText = f.title;
        modalCardFeatureSelect.appendChild(opt);
      });
    }

    function renderModalSubStories() {
      modalSubStoriesContainer.innerHTML = '';
      if (!modalSubStories || modalSubStories.length === 0) {
        modalSubStoriesContainer.innerHTML = '<span style="font-size: 11px; color: var(--text-muted); font-style: italic;">No sub-stories added yet. Click "+ Add Sub-Story" above to break this down into smaller units.</span>';
        return;
      }

      modalSubStories.forEach((sub, idx) => {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.gap = '8px';
        row.style.background = 'rgba(255, 255, 255, 0.02)';
        row.style.border = '1px solid var(--border-subtle)';
        row.style.padding = '4px 8px';
        row.style.borderRadius = '4px';

        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = !!sub.completed;
        check.style.cursor = 'pointer';
        check.onchange = () => { sub.completed = check.checked; };

        const textInput = document.createElement('input');
        textInput.type = 'text';
        textInput.className = 'form-input';
        textInput.style.flex = '1';
        textInput.style.padding = '3px 6px';
        textInput.style.fontSize = '12px';
        textInput.placeholder = 'Sub-task title / requirement...';
        textInput.value = sub.title;
        textInput.oninput = () => { sub.title = textInput.value; };

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'card-action-btn';
        delBtn.style.color = 'var(--danger)';
        delBtn.innerHTML = \`
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px;">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        \`;
        delBtn.onclick = () => {
          modalSubStories.splice(idx, 1);
          renderModalSubStories();
        };

        row.appendChild(check);
        row.appendChild(textInput);
        row.appendChild(delBtn);
        modalSubStoriesContainer.appendChild(row);
      });
    }

    function openFeaturesModal() {
      renderFeaturesListModal();
      featuresModal.classList.add('open');
    }

    function renderFeaturesListModal() {
      const container = document.getElementById('featuresListContainer');
      container.innerHTML = '';

      if (!currentBoard || !currentBoard.features || currentBoard.features.length === 0) {
        container.innerHTML = '<span style="font-size: 11px; color: var(--text-muted); font-style: italic;">No features created yet in this workspace.</span>';
        return;
      }

      currentBoard.features.forEach(f => {
        const fCards = currentBoard.cards.filter(c => c.featureId === f.id);
        const doneCards = fCards.filter(c => c.columnId === 'done');
        const fDiv = document.createElement('div');
        fDiv.style.display = 'flex';
        fDiv.style.alignItems = 'center';
        fDiv.style.justifyContent = 'space-between';
        fDiv.style.background = 'rgba(255, 255, 255, 0.02)';
        fDiv.style.border = '1px solid var(--border-subtle)';
        fDiv.style.padding = '8px 12px';
        fDiv.style.borderRadius = '4px';

        fDiv.innerHTML = \`
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="width: 10px; height: 10px; border-radius: 50%; background: \${f.color || '#3b82f6'};"></span>
            <div style="display: flex; flex-direction: column;">
              <span style="font-weight: 600; font-size: 12px;">\${escapeHtml(f.title)}</span>
              <span style="font-size: 11px; color: var(--text-muted);">\${escapeHtml(f.description || '')} • \${doneCards.length}/\${fCards.length} stories done</span>
            </div>
          </div>
          <div>
            <button class="card-action-btn" onclick="deleteFeature('\${f.id}', event)" title="Delete Feature" style="color: var(--danger);">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        \`;
        container.appendChild(fDiv);
      });
    }

    function deleteFeature(featureId, e) {
      if (e) {
        e.stopPropagation();
        e.preventDefault();
      }
      if (!currentBoard) return;

      currentBoard.features = (currentBoard.features || []).filter(f => f.id !== featureId);
      currentBoard.cards.forEach(c => {
        if (c.featureId === featureId) {
          delete c.featureId;
        }
      });

      if (activeFeatureFilter === featureId) {
        activeFeatureFilter = 'all';
      }

      populateFeaturesBar();
      populateFeatureSelectDropdown();
      renderFeaturesListModal();
      renderBoard();
      vscode.postMessage({ type: 'saveBoard', board: currentBoard });
    }

    function toggleSubStoryOnCard(cardId, subId, completed) {
      if (!currentBoard) return;
      const card = currentBoard.cards.find(c => c.id === cardId);
      if (!card || !card.subStories) return;
      const sub = card.subStories.find(s => s.id === subId);
      if (sub) {
        sub.completed = completed;
        card.updatedAt = new Date().toISOString();
        renderBoard();
        populateFeaturesBar();
        vscode.postMessage({ type: 'saveBoard', board: currentBoard });
      }
    }

    function updateRalphStatus(status, card) {
      ralphStatus = status;
      activeCard = card;
      statusBadge.className = 'status-pill ' + status;
      statusText.innerText = status.toUpperCase();

      if (status === 'running' || status === 'verifying') {
        btnStart.style.display = 'none';
        btnPause.style.display = 'inline-flex';
        btnStop.style.display = 'inline-flex';
      } else if (status === 'paused') {
        btnStart.querySelector('span').innerText = 'Resume';
        btnStart.style.display = 'inline-flex';
        btnPause.style.display = 'none';
        btnStop.style.display = 'inline-flex';
      } else {
        btnStart.querySelector('span').innerText = 'Start Ralph';
        btnStart.style.display = 'inline-flex';
        btnPause.style.display = 'none';
        btnStop.style.display = 'none';
        activeCardLabel.innerText = '';
      }

      renderBoard();
    }

    function renderBoard() {
      if (!currentBoard) return;

      const searchTerm = (document.getElementById('searchFilterInput').value || '').toLowerCase();
      const priorityFilter = document.getElementById('priorityFilterSelect').value;
      const typeFilter = typeFilterSelect ? typeFilterSelect.value : 'all';

      boardContainer.innerHTML = '';

      // Normalize columns: exactly 3 columns (Queue, Running, Completed)
      const standardCols = [
        { id: 'pending', title: 'Queue' },
        { id: 'in_progress', title: 'Running' },
        { id: 'done', title: 'Completed' }
      ];

      standardCols.forEach(col => {
        const colDiv = document.createElement('div');
        colDiv.className = 'kanban-column';
        colDiv.dataset.columnId = col.id;

        // Cards in column (including backwards compatibility migration)
        let cards = currentBoard.cards.filter(c => {
          if (col.id === 'pending') {
            return c.columnId === 'pending' || c.columnId === 'backlog' || c.columnId === 'todo';
          } else if (col.id === 'in_progress') {
            return c.columnId === 'in_progress' || c.columnId === 'in_review';
          } else {
            return c.columnId === 'done';
          }
        });
        
        // Filter by Feature
        if (activeFeatureFilter !== 'all') {
          cards = cards.filter(c => c.featureId === activeFeatureFilter);
        }

        // Filter by Item Type
        if (typeFilter !== 'all') {
          cards = cards.filter(c => (c.type || 'story') === typeFilter);
        }

        // Filter by Priority
        if (priorityFilter !== 'all') {
          cards = cards.filter(c => c.priority === priorityFilter);
        }

        // Filter by Search Query
        if (searchTerm) {
          cards = cards.filter(c => {
            const feat = (currentBoard.features || []).find(f => f.id === c.featureId);
            const featMatch = feat && feat.title.toLowerCase().includes(searchTerm);
            const subMatch = (c.subStories || []).some(s => s.title.toLowerCase().includes(searchTerm));
            return (
              c.title.toLowerCase().includes(searchTerm) || 
              c.id.toLowerCase().includes(searchTerm) || 
              (c.description && c.description.toLowerCase().includes(searchTerm)) ||
              featMatch ||
              subMatch ||
              (c.tags && c.tags.some(t => t.toLowerCase().includes(searchTerm)))
            );
          });
        }

        colDiv.innerHTML = \`
          <div class="column-header">
            <div class="column-title-group">
              <span>\${col.title}</span>
              <span class="column-counter">\${cards.length}</span>
            </div>
            <button class="card-action-btn" onclick="openNewCardInColumn('\${col.id}')" title="Add task to \${col.title}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
            </button>
          </div>
          <div class="column-cards-container" data-column-id="\${col.id}"></div>
        \`;

        const cardsContainer = colDiv.querySelector('.column-cards-container');

        // Drag and drop event listeners on column container
        cardsContainer.addEventListener('dragover', (e) => {
          e.preventDefault();
          cardsContainer.classList.add('dragover');
        });
        cardsContainer.addEventListener('dragleave', () => {
          cardsContainer.classList.remove('dragover');
        });
        cardsContainer.addEventListener('drop', (e) => {
          e.preventDefault();
          cardsContainer.classList.remove('dragover');
          const cardId = e.dataTransfer.getData('text/plain');
          moveCardToColumn(cardId, col.id);
        });

        cards.forEach(card => {
          const cardEl = createCardElement(card);
          cardsContainer.appendChild(cardEl);
        });

        boardContainer.appendChild(colDiv);
      });
    }

    function createCardElement(card) {
      const cardEl = document.createElement('div');
      cardEl.className = 'kanban-card' + (activeCard && activeCard.id === card.id ? ' active-ralph' : '');
      cardEl.draggable = true;
      cardEl.dataset.cardId = card.id;

      cardEl.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', card.id);
      });

      const priorityClass = 'priority-' + card.priority;
      const typeStr = card.type || 'story';

      // Feature badge
      let featureHtml = '';
      if (card.featureId && currentBoard && currentBoard.features) {
        const feat = currentBoard.features.find(f => f.id === card.featureId);
        if (feat) {
          featureHtml = \`<span class="meta-feature" style="border-left: 3px solid \${feat.color || '#3b82f6'};">\${escapeHtml(feat.title)}</span>\`;
        }
      }

      // Sub-stories section
      let subStoriesHtml = '';
      if (card.subStories && card.subStories.length > 0) {
        const completedCount = card.subStories.filter(s => s.completed).length;
        const totalSub = card.subStories.length;
        const percent = Math.round((completedCount / totalSub) * 100);
        const subListHtml = card.subStories.map(s => \`
          <div class="card-substory-row">
            <input type="checkbox" \${s.completed ? 'checked' : ''} onchange="toggleSubStoryOnCard('\${card.id}', '\${s.id}', this.checked)">
            <span class="\${s.completed ? 'substory-done' : ''}">\${escapeHtml(s.title)}</span>
          </div>
        \`).join('');

        subStoriesHtml = \`
          <div class="card-substories">
            <div style="display: flex; justify-content: space-between; font-size: 10px; color: var(--text-muted); margin-bottom: 4px;">
              <span>Sub-stories</span>
              <span>\${completedCount}/\${totalSub}</span>
            </div>
            <div class="substory-progress-bar">
              <div class="substory-progress-fill" style="width: \${percent}%;"></div>
            </div>
            \${subListHtml}
          </div>
        \`;
      }

      let tagsHtml = (card.tags || []).map(t => \`<span class="meta-tag">#\${t}</span>\`).join('');
      let modelHtml = card.model ? \`<span class="meta-model">\${card.model}</span>\` : '';
      let verifyHtml = card.verificationCommand ? \`<span class="meta-verify">test: \${card.verificationCommand}</span>\` : '';
      let iterHtml = card.iterationCount > 0 ? \`<span class="meta-tag">Iter: \${card.iterationCount}/\${card.maxIterations}</span>\` : '';

      cardEl.innerHTML = \`
        <div class="card-top-row">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="card-id">\${card.id}</span>
            <span class="meta-type type-\${typeStr}">\${typeStr}</span>
          </div>
          <span class="priority-badge \${priorityClass}">\${card.priority}</span>
        </div>
        \${featureHtml}
        <div class="card-title">\${escapeHtml(card.title)}</div>
        <div class="card-desc">\${escapeHtml(card.description || '')}</div>
        \${subStoriesHtml}
        <div class="card-meta-row">
          \${modelHtml}
          \${verifyHtml}
          \${tagsHtml}
          \${iterHtml}
        </div>
        <div class="card-bottom-actions">
          <div style="display: flex; gap: 4px;">
            <button class="card-action-btn" onclick="startRalphOnCard('\${card.id}')" title="Run Ralph Loop on this task">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
              <span>Run</span>
            </button>
            <button class="card-action-btn" onclick="openEditCardModal('\${card.id}')" title="Edit Task">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
              <span>Edit</span>
            </button>
          </div>
          <div>
            <button class="card-action-btn" onclick="deleteCard('\${card.id}', event)" title="Delete Task" style="color: var(--danger);">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>
      \`;

      return cardEl;
    }

    function moveCardToColumn(cardId, newColId) {
      if (!currentBoard) return;
      const card = currentBoard.cards.find(c => c.id === cardId);
      if (card && card.columnId !== newColId) {
        card.columnId = newColId;
        card.updatedAt = new Date().toISOString();
        if (newColId === 'done') {
          card.completedAt = new Date().toISOString();
        }
        renderBoard();
        vscode.postMessage({ type: 'saveBoard', board: currentBoard });
      }
    }

    function startRalphOnCard(cardId) {
      vscode.postMessage({ type: 'startRalphLoop', cardId });
    }

    function openEditCardModal(cardId) {
      const card = currentBoard.cards.find(c => c.id === cardId);
      if (!card) return;

      document.getElementById('modalCardId').value = card.id;
      document.getElementById('modalCardTitleHeading').innerText = 'Edit ' + card.id;
      document.getElementById('modalCardTitleInput').value = card.title;
      document.getElementById('modalCardDescInput').value = card.description || '';
      document.getElementById('modalCardFeatureSelect').value = card.featureId || '';
      document.getElementById('modalCardTypeSelect').value = card.type || 'story';
      document.getElementById('modalCardColumnSelect').value = (card.columnId === 'backlog' || card.columnId === 'todo') ? 'pending' : (card.columnId === 'in_review') ? 'in_progress' : card.columnId;
      document.getElementById('modalCardPrioritySelect').value = card.priority;
      document.getElementById('modalCardTagsInput').value = (card.tags || []).join(', ');
      document.getElementById('modalCardModelSelect').value = card.model || 'Gemini 3.8 Flash (High)';
      document.getElementById('modalCardVerifyInput').value = card.verificationCommand || '';
      document.getElementById('modalCardCriteriaInput').value = (card.acceptanceCriteria || []).join('\\n');

      const btnDel = document.getElementById('btnDeleteCardModal');
      if (btnDel) {
        btnDel.style.display = 'inline-flex';
        btnDel.onclick = () => {
          cardModal.classList.remove('open');
          deleteCard(card.id);
        };
      }

      modalSubStories = JSON.parse(JSON.stringify(card.subStories || []));
      renderModalSubStories();

      cardModal.classList.add('open');
    }

    function deleteCard(cardId, e) {
      if (e) {
        e.stopPropagation();
        e.preventDefault();
      }
      if (!currentBoard) return;
      currentBoard.cards = currentBoard.cards.filter(c => c.id !== cardId);
      renderBoard();
      populateFeaturesBar();
      vscode.postMessage({ type: 'saveBoard', board: currentBoard });
    }

    function openNewCardInColumn(colId) {
      document.getElementById('modalCardId').value = '';
      document.getElementById('modalCardTitleHeading').innerText = 'New Story / Task';
      document.getElementById('modalCardTitleInput').value = '';
      document.getElementById('modalCardDescInput').value = '';
      document.getElementById('modalCardFeatureSelect').value = activeFeatureFilter !== 'all' ? activeFeatureFilter : '';
      document.getElementById('modalCardTypeSelect').value = 'story';
      document.getElementById('modalCardColumnSelect').value = colId || 'pending';
      document.getElementById('modalCardPrioritySelect').value = 'medium';
      document.getElementById('modalCardTagsInput').value = '';
      document.getElementById('modalCardModelSelect').value = 'Gemini 3.8 Flash (High)';
      document.getElementById('modalCardVerifyInput').value = '';
      document.getElementById('modalCardCriteriaInput').value = '';

      const btnDel = document.getElementById('btnDeleteCardModal');
      if (btnDel) {
        btnDel.style.display = 'none';
      }

      modalSubStories = [];
      renderModalSubStories();

      cardModal.classList.add('open');
    }

    // Add sub-story input inside modal
    document.getElementById('btnAddSubStoryInput').addEventListener('click', () => {
      const nextNum = modalSubStories.length + 1;
      modalSubStories.push({
        id: 'SUB-' + String(nextNum).padStart(3, '0'),
        title: '',
        completed: false
      });
      renderModalSubStories();
    });

    // Features Modal Events
    document.getElementById('btnManageFeatures').addEventListener('click', () => openFeaturesModal());
    document.getElementById('btnCloseFeaturesModal').addEventListener('click', () => featuresModal.classList.remove('open'));
    document.getElementById('btnDoneFeaturesModal').addEventListener('click', () => featuresModal.classList.remove('open'));

    document.getElementById('btnCreateFeatureSubmit').addEventListener('click', () => {
      const titleInput = document.getElementById('newFeatureTitleInput');
      const title = titleInput.value.trim();
      if (!title) {
        titleInput.focus();
        titleInput.style.borderColor = 'var(--danger)';
        setTimeout(() => { titleInput.style.borderColor = ''; }, 1500);
        return;
      }
      const color = document.getElementById('newFeatureColorSelect').value;
      const desc = document.getElementById('newFeatureDescInput').value.trim();
      const nextFeatNum = (currentBoard.features || []).length + 1;
      const featId = 'FEAT-' + String(nextFeatNum).padStart(3, '0');

      currentBoard.features = currentBoard.features || [];
      currentBoard.features.push({
        id: featId,
        title,
        description: desc,
        color,
        status: 'active'
      });

      titleInput.value = '';
      document.getElementById('newFeatureDescInput').value = '';

      populateFeaturesBar();
      populateFeatureSelectDropdown();
      renderFeaturesListModal();
      renderBoard();
      vscode.postMessage({ type: 'saveBoard', board: currentBoard });
    });

    // Modal Events
    document.getElementById('btnOpenNewCardModal').addEventListener('click', () => openNewCardInColumn('pending'));
    document.getElementById('btnCloseCardModal').addEventListener('click', () => cardModal.classList.remove('open'));
    document.getElementById('btnCancelCardModal').addEventListener('click', () => cardModal.classList.remove('open'));

    document.getElementById('btnSaveCardModal').addEventListener('click', () => {
      const id = document.getElementById('modalCardId').value;
      const titleInput = document.getElementById('modalCardTitleInput');
      const title = titleInput.value.trim();
      if (!title) {
        titleInput.focus();
        titleInput.style.borderColor = 'var(--danger)';
        setTimeout(() => { titleInput.style.borderColor = ''; }, 1500);
        return;
      }

      const description = document.getElementById('modalCardDescInput').value.trim();
      const featureId = document.getElementById('modalCardFeatureSelect').value || undefined;
      const type = document.getElementById('modalCardTypeSelect').value || 'story';
      const columnId = document.getElementById('modalCardColumnSelect').value;
      const priority = document.getElementById('modalCardPrioritySelect').value;
      const tags = document.getElementById('modalCardTagsInput').value
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0);
      const model = document.getElementById('modalCardModelSelect').value || 'Gemini 3.8 Flash (High)';
      const verificationCommand = document.getElementById('modalCardVerifyInput').value.trim() || undefined;
      const acceptanceCriteria = document.getElementById('modalCardCriteriaInput').value
        .split('\\n')
        .map(c => c.trim())
        .filter(c => c.length > 0);

      // Clean up sub-stories
      const validSubStories = modalSubStories
        .map(s => ({ ...s, title: s.title.trim() }))
        .filter(s => s.title.length > 0);

      if (id) {
        const card = currentBoard.cards.find(c => c.id === id);
        if (card) {
          card.title = title;
          card.description = description;
          card.featureId = featureId;
          card.type = type;
          card.columnId = columnId;
          card.priority = priority;
          card.subStories = validSubStories;
          card.tags = tags;
          card.model = model;
          card.verificationCommand = verificationCommand;
          card.acceptanceCriteria = acceptanceCriteria;
          card.updatedAt = new Date().toISOString();
        }
      } else {
        const nextNum = currentBoard.cards.length + 1;
        const prefix = type === 'bug' ? 'BUG-' : type === 'task' ? 'TASK-' : 'STORY-';
        const newId = prefix + String(nextNum).padStart(3, '0');
        currentBoard.cards.push({
          id: newId,
          title,
          description,
          featureId,
          type,
          columnId,
          priority,
          subStories: validSubStories,
          tags,
          model,
          verificationCommand,
          acceptanceCriteria,
          iterationCount: 0,
          maxIterations: 5,
          logs: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }

      cardModal.classList.remove('open');
      renderBoard();
      populateFeaturesBar();
      vscode.postMessage({ type: 'saveBoard', board: currentBoard });
    });

    if (typeFilterSelect) {
      typeFilterSelect.addEventListener('change', renderBoard);
    }

    // Settings Modal
    document.getElementById('btnOpenSettings').addEventListener('click', () => {
      if (currentBoard && currentBoard.ralphConfig) {
        document.getElementById('inputOllamaUrl').value = currentBoard.ralphConfig.ollamaEndpoint || '';
        document.getElementById('inputCustomUrl').value = currentBoard.ralphConfig.customApiEndpoint || '';
      }
      settingsModal.classList.add('open');
    });

    document.getElementById('btnCloseSettingsModal').addEventListener('click', () => settingsModal.classList.remove('open'));
    document.getElementById('btnCancelSettingsModal').addEventListener('click', () => settingsModal.classList.remove('open'));

    document.getElementById('btnSaveSettingsModal').addEventListener('click', () => {
      const anthropic = document.getElementById('inputAnthropicKey').value.trim();
      const openai = document.getElementById('inputOpenAiKey').value.trim();
      const gemini = document.getElementById('inputGeminiKey').value.trim();
      const deepseek = document.getElementById('inputDeepSeekKey').value.trim();

      if (currentBoard && currentBoard.ralphConfig) {
        currentBoard.ralphConfig.ollamaEndpoint = document.getElementById('inputOllamaUrl').value.trim() || 'http://127.0.0.1:11434';
        currentBoard.ralphConfig.customApiEndpoint = document.getElementById('inputCustomUrl').value.trim() || 'https://api.deepseek.com/v1';
        vscode.postMessage({ type: 'saveBoard', board: currentBoard });
      }

      vscode.postMessage({
        type: 'saveApiKeys',
        keys: { anthropic, openai, gemini, deepseek }
      });

      settingsModal.classList.remove('open');
    });

    // Ralph Buttons
        const btnSendToChat = document.getElementById('btnSendToChat');
    if (btnSendToChat) {
      btnSendToChat.addEventListener('click', () => {
        const targetCard = activeCard || (currentBoard && currentBoard.cards.find(c => c.columnId === 'in_progress' || c.columnId === 'pending' || c.columnId === 'todo'));
        vscode.postMessage({ type: 'sendToChat', cardId: targetCard ? targetCard.id : undefined });
      });
    }

    function sendCardToChat(cardId, e) {
      if (e) e.stopPropagation();
      vscode.postMessage({ type: 'sendToChat', cardId });
    }
    window.sendCardToChat = sendCardToChat;

    btnStart.addEventListener('click', () => {
      vscode.postMessage({ type: 'startRalphLoop' });
    });
    btnPause.addEventListener('click', () => {
      vscode.postMessage({ type: 'pauseRalphLoop' });
    });
    btnStop.addEventListener('click', () => {
      vscode.postMessage({ type: 'stopRalphLoop' });
    });

    // Model Dropdown Change
    modelDropdown.addEventListener('change', () => {
      if (currentBoard && currentBoard.ralphConfig) {
        const selectedId = modelDropdown.value;
        currentBoard.ralphConfig.defaultModel = selectedId;
        const matched = availableModels.find(m => m.id === selectedId);
        if (matched && (matched.isNative || matched.provider === 'antigravity' || matched.provider === 'antigravity-lm')) {
          if (!['Planning', 'Fast', 'Pseudo-Ralph'].includes(currentBoard.ralphConfig.executionMode)) {
            currentBoard.ralphConfig.executionMode = 'Planning';
            modeDropdown.value = 'Planning';
          }
        }
        vscode.postMessage({ type: 'saveBoard', board: currentBoard });
      }
    });

    // Mode Dropdown Change
    modeDropdown.addEventListener('change', () => {
      if (currentBoard && currentBoard.ralphConfig) {
        currentBoard.ralphConfig.executionMode = modeDropdown.value;
        vscode.postMessage({ type: 'saveBoard', board: currentBoard });
      }
    });

    // Search and Filter Listeners
    document.getElementById('searchFilterInput').addEventListener('input', renderBoard);
    document.getElementById('priorityFilterSelect').addEventListener('change', renderBoard);
    document.getElementById('btnReloadDisk').addEventListener('click', () => {
      vscode.postMessage({ type: 'reloadFromDisk' });
    });
    document.getElementById('btnClearLogs').addEventListener('click', () => {
      logContainer.innerHTML = '';
    });

    function appendLogEntry(log) {
      const entryEl = document.createElement('div');
      entryEl.className = 'log-entry';
      const timeStr = log.timestamp ? log.timestamp.split('T')[1]?.split('.')[0] || log.timestamp : '';
      entryEl.innerHTML = \`
        <span class="log-time">[\${timeStr}]</span>
        <span class="log-type-\${log.type}">[\${log.type.toUpperCase()}]</span>
        <span>\${escapeHtml(log.message)}</span>
      \`;
      logContainer.appendChild(entryEl);
      logContainer.scrollTop = logContainer.scrollHeight;
    }

    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Explicitly expose functions to window scope for inline onclick handlers
    window.deleteCard = deleteCard;
    window.deleteFeature = deleteFeature;
    window.openEditCardModal = openEditCardModal;
    window.openNewCardInColumn = openNewCardInColumn;
    window.startRalphOnCard = startRalphOnCard;
    window.toggleSubStoryOnCard = toggleSubStoryOnCard;
    window.openFeaturesModal = openFeaturesModal;
    window.moveCardToColumn = moveCardToColumn;
  </script>
</body>
</html>`;
  }
}
