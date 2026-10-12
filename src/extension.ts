import * as vscode from 'vscode';
import { FileManager } from './storage/FileManager';
import { RalphLoopEngine } from './engine/RalphLoopEngine';
import { KanbanWebviewPanel } from './webview/KanbanWebviewPanel';
import { KanbanSidebarProvider } from './sidebar/KanbanSidebarProvider';

let fileManager: FileManager | undefined;
let ralphEngine: RalphLoopEngine | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  if (!workspaceRoot) {
    vscode.commands.registerCommand('antigravity-kanban.openBoard', () => {
      vscode.window.showWarningMessage('Please open a workspace or folder in Antigravity to use Kanban.');
    });
    return;
  }

  // 1. Ensure .antigravity/kanban.json is placed in each workspace repo
  FileManager.initializeAllWorkspaces();

  // 2. Initialize Storage & File Manager (.antigravity/kanban.json + KANBAN.md)
  fileManager = new FileManager(workspaceRoot);
  context.subscriptions.push(fileManager);

  // 3. Initialize Ralph Autonomous Loop Engine
  ralphEngine = new RalphLoopEngine(workspaceRoot, fileManager, context.secrets);

  // 3. Register Activity Bar Sidebar Provider
  const sidebarProvider = new KanbanSidebarProvider(context.extensionUri, fileManager, ralphEngine);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(KanbanSidebarProvider.viewType, sidebarProvider)
  );

  // 4. Create Status Bar Item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'antigravity-kanban.openBoard';
  statusBarItem.text = '$(project) Kanban: Ralph Idle';
  statusBarItem.tooltip = 'Click to open Antigravity Kanban Board';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Update Status Bar on Ralph status change
  ralphEngine.onStatusChange((status) => {
    if (!statusBarItem) return;
    const card = ralphEngine?.getActiveCard();
    if (status === 'running') {
      statusBarItem.text = `$(sync~spin) Ralph: [${card?.id || 'Loop'}]`;
      statusBarItem.color = '#f59e0b';
    } else if (status === 'verifying') {
      statusBarItem.text = `$(beaker~spin) Ralph: Verifying...`;
      statusBarItem.color = '#a855f7';
    } else if (status === 'paused') {
      statusBarItem.text = `$(debug-pause) Ralph: Paused`;
      statusBarItem.color = '#f9e2af';
    } else {
      statusBarItem.text = '$(project) Kanban: Ralph Idle';
      statusBarItem.color = undefined;
    }
  });

  // 5. Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravity-kanban.openBoard', () => {
      if (fileManager && ralphEngine) {
        KanbanWebviewPanel.createOrShow(context.extensionUri, fileManager, ralphEngine, context.secrets);
      }
    }),

    vscode.commands.registerCommand('antigravity-kanban.startRalphLoop', async () => {
      if (ralphEngine) {
        await ralphEngine.startLoop();
      }
    }),

    vscode.commands.registerCommand('antigravity-kanban.pauseRalphLoop', () => {
      if (ralphEngine) {
        ralphEngine.pauseLoop();
      }
    }),

    vscode.commands.registerCommand('antigravity-kanban.stopRalphLoop', () => {
      if (ralphEngine) {
        ralphEngine.stopLoop();
      }
    }),

    vscode.commands.registerCommand('antigravity-kanban.addTask', async () => {
      if (!fileManager) return;
      const title = await vscode.window.showInputBox({
        prompt: 'Enter task title for Antigravity Kanban board',
        placeHolder: 'e.g., Implement eBPF kernel event probes'
      });
      if (title && title.trim()) {
        const board = await fileManager.loadBoard();
        const nextId = 'TASK-' + String(board.cards.length + 1).padStart(3, '0');
        board.cards.push({
          id: nextId,
          title: title.trim(),
          description: '',
          columnId: 'pending',
          priority: 'medium',
          type: 'story',
          model: 'Gemini 3.8 Flash (High)',
          subStories: [],
          tags: ['task'],
          iterationCount: 0,
          maxIterations: 5,
          acceptanceCriteria: [],
          logs: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        await fileManager.saveBoard(board);
        vscode.window.showInformationMessage(`Task [${nextId}] added to To Do list.`);
        vscode.commands.executeCommand('antigravity-kanban.openBoard');
      }
    }),

    vscode.commands.registerCommand('antigravity-kanban.refresh', async () => {
      if (fileManager) {
        await fileManager.loadBoard();
        vscode.window.showInformationMessage('Kanban board synchronized from disk.');
      }
    })
  );
}

export function deactivate(): void {
  if (ralphEngine) {
    ralphEngine.stopLoop();
  }
}
