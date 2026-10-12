import * as vscode from 'vscode';
import { FileManager } from '../storage/FileManager';
import { RalphLoopEngine } from '../engine/RalphLoopEngine';
import { KanbanBoard } from '../types/kanban';

export class KanbanSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'antigravity-kanban.sidebarView';
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly fileManager: FileManager,
    private readonly ralphEngine: RalphLoopEngine
  ) {
    this.fileManager.onBoardChanged(() => this.updateWebviewContent());
    this.ralphEngine.onStatusChange(() => this.updateWebviewContent());
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this.getHtmlForWebview();

    webviewView.webview.onDidReceiveMessage((data) => {
      switch (data.type) {
        case 'openBoard':
          vscode.commands.executeCommand('antigravity-kanban.openBoard');
          break;
        case 'startRalph':
          vscode.commands.executeCommand('antigravity-kanban.startRalphLoop');
          break;
        case 'pauseRalph':
          vscode.commands.executeCommand('antigravity-kanban.pauseRalphLoop');
          break;
        case 'addTask':
          vscode.commands.executeCommand('antigravity-kanban.addTask');
          break;
        case 'refresh':
          this.updateWebviewContent();
          break;
      }
    });

    this.updateWebviewContent();
  }

  public async updateWebviewContent(): Promise<void> {
    if (!this.view) return;
    try {
      const board = await this.fileManager.loadBoard();
      const status = this.ralphEngine.getStatus();
      const activeCard = this.ralphEngine.getActiveCard();

      this.view.webview.postMessage({
        type: 'update',
        board,
        status,
        activeCard
      });
    } catch (err) {
      console.error('Error updating sidebar webview:', err);
    }
  }

  private getHtmlForWebview(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 12px);
      color: var(--vscode-foreground);
      padding: 10px;
      margin: 0;
      background: var(--vscode-sideBar-background);
      -webkit-font-smoothing: antialiased;
    }

    .header-box {
      margin-bottom: 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 7px;
      border-radius: 3px;
      font-size: 10.5px;
      font-weight: 700;
      text-transform: uppercase;
      font-family: monospace;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-widget-border);
      align-self: flex-start;
    }

    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #888;
    }

    .status-badge.running .dot {
      background: #f59e0b;
      box-shadow: 0 0 6px #f59e0b;
    }

    .status-badge.verifying .dot {
      background: #3b82f6;
      box-shadow: 0 0 6px #3b82f6;
    }

    .status-badge.idle .dot {
      background: #10b981;
    }

    .counts-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 5px;
      margin-bottom: 12px;
    }

    .count-card {
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 4px;
      padding: 6px 8px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
    }

    .count-label {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      font-weight: 600;
    }

    .count-value {
      font-size: 14px;
      font-weight: 700;
      font-family: monospace;
    }

    .btn {
      width: 100%;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 6px 10px;
      border-radius: 3px;
      font-size: 11.5px;
      cursor: pointer;
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 6px;
      margin-bottom: 6px;
      font-weight: 600;
      font-family: inherit;
    }

    .btn:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .btn-secondary {
      background: var(--vscode-button-secondaryBackground, #2d3139);
      color: var(--vscode-button-secondaryForeground, #abb2bf);
    }

    .btn-secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground, #3e4451);
    }

    .tasks-section {
      margin-top: 12px;
    }

    .tasks-header {
      font-size: 10.5px;
      font-weight: 700;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
      letter-spacing: 0.03em;
    }

    .task-item {
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 4px;
      padding: 7px 9px;
      margin-bottom: 5px;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .task-id {
      font-size: 10px;
      font-family: monospace;
      color: var(--vscode-textLink-foreground);
      font-weight: 600;
      display: flex;
      justify-content: space-between;
    }

    .task-title {
      font-size: 11.5px;
      font-weight: 500;
      line-height: 1.35;
    }
  </style>
</head>
<body>
  <div class="header-box">
    <div class="status-badge idle" id="statusBadge">
      <span class="dot"></span>
      <span id="statusText">RALPH: IDLE</span>
    </div>
    <div id="activeTaskBanner" style="font-size: 11px; color: var(--vscode-descriptionForeground); display: none;"></div>
  </div>

  <button class="btn" onclick="postAction('openBoard')">
    Open Kanban Board
  </button>
  <button class="btn btn-secondary" id="btnRalphAction" onclick="postAction('startRalph')">
    Run Ralph Loop
  </button>

  <div class="counts-grid">
    <div class="count-card">
      <span class="count-label">Queue</span>
      <span class="count-value" id="countPending">0</span>
    </div>
    <div class="count-card">
      <span class="count-label">Running</span>
      <span class="count-value" id="countProgress" style="color: #f59e0b;">0</span>
    </div>
    <div class="count-card">
      <span class="count-label">Done</span>
      <span class="count-value" id="countDone" style="color: #10b981;">0</span>
    </div>
  </div>

  <div class="tasks-section">
    <div class="tasks-header">Active & Queue Tasks</div>
    <div id="upcomingTasksList">
      <div style="font-size: 11px; color: var(--vscode-descriptionForeground);">Loading tasks...</div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function postAction(type) {
      vscode.postMessage({ type });
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'update') {
        const board = msg.board;
        const status = msg.status || 'idle';
        const activeCard = msg.activeCard;

        // Update status badge
        const badge = document.getElementById('statusBadge');
        const text = document.getElementById('statusText');
        badge.className = 'status-badge ' + status;
        text.innerText = 'RALPH: ' + status.toUpperCase();

        const btnRalph = document.getElementById('btnRalphAction');
        if (status === 'running' || status === 'verifying') {
          btnRalph.innerText = 'Pause Ralph Loop';
          btnRalph.onclick = () => postAction('pauseRalph');
        } else {
          btnRalph.innerText = 'Run Ralph Loop';
          btnRalph.onclick = () => postAction('startRalph');
        }

        const banner = document.getElementById('activeTaskBanner');
        if (activeCard) {
          banner.style.display = 'block';
          banner.innerText = 'Active: [' + activeCard.id + '] ' + activeCard.title;
        } else {
          banner.style.display = 'none';
        }

        if (board && board.cards) {
          const pendingCount = board.cards.filter(c => c.columnId === 'pending' || c.columnId === 'backlog' || c.columnId === 'todo').length;
          const progressCount = board.cards.filter(c => c.columnId === 'in_progress' || c.columnId === 'in_review').length;
          const doneCount = board.cards.filter(c => c.columnId === 'done').length;

          document.getElementById('countPending').innerText = pendingCount;
          document.getElementById('countProgress').innerText = progressCount;
          document.getElementById('countDone').innerText = doneCount;

          const list = document.getElementById('upcomingTasksList');
          const pending = board.cards.filter(c => c.columnId === 'in_progress' || c.columnId === 'pending' || c.columnId === 'todo').slice(0, 4);
          if (pending.length === 0) {
            list.innerHTML = '<div style="font-size: 11px; color: var(--vscode-descriptionForeground);">No active tasks in queue.</div>';
          } else {
            list.innerHTML = pending.map(c => \`
              <div class="task-item">
                <div class="task-id">
                  <span>\${c.id}</span>
                  \${c.columnId === 'in_progress' ? '<span style="color: #f59e0b;">RUNNING</span>' : ''}
                </div>
                <div class="task-title">\${escapeHtml(c.title)}</div>
              </div>
            \`).join('');
          }
        }
      }
    });

    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
  </script>
</body>
</html>`;
  }
}
