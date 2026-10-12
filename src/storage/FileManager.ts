import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { KanbanBoard, KanbanCard, KanbanColumn, ColumnId, Priority, DEFAULT_COLUMNS, DEFAULT_RALPH_CONFIG } from '../types/kanban';

export class FileManager {
  private workspaceRoot: string;
  private configDir: string;
  private jsonPath: string;
  private mdPath: string;
  private fileWatcher?: vscode.FileSystemWatcher;
  private isSaving: boolean = false;
  private onBoardChangeEmitter = new vscode.EventEmitter<KanbanBoard>();

  public readonly onBoardChanged = this.onBoardChangeEmitter.event;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.configDir = path.join(this.workspaceRoot, '.antigravity');
    this.jsonPath = path.join(this.configDir, 'kanban.json');
    this.mdPath = path.join(this.configDir, 'KANBAN.md');

    this.ensureDirectoryExists();
    this.setupFileWatcher();
  }

  public getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  public async setWorkspaceRoot(newRoot: string): Promise<KanbanBoard> {
    const normCurrent = this.workspaceRoot.replace(/[/\\]+/g, '/').toLowerCase();
    const normNew = newRoot.replace(/[/\\]+/g, '/').toLowerCase();
    if (normCurrent === normNew) {
      return this.loadBoard();
    }
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
    }
    this.workspaceRoot = newRoot;
    this.configDir = path.join(this.workspaceRoot, '.antigravity');
    this.jsonPath = path.join(this.configDir, 'kanban.json');
    this.mdPath = path.join(this.configDir, 'KANBAN.md');

    this.ensureDirectoryExists();
    this.setupFileWatcher();
    const board = await this.loadBoard();
    this.onBoardChangeEmitter.fire(board);
    return board;
  }

  public static getWorkspaceProjects(currentRoot?: string): { name: string; path: string }[] {
    const projectMap = new Map<string, { name: string; path: string }>();

    // 1. All open workspace folders in VS Code
    const folders = vscode.workspace.workspaceFolders || [];
    for (const f of folders) {
      const norm = f.uri.fsPath.replace(/[/\\]+/g, '/').toLowerCase();
      projectMap.set(norm, {
        name: f.name,
        path: f.uri.fsPath
      });
    }

    // 2. Current root
    if (currentRoot) {
      const norm = currentRoot.replace(/[/\\]+/g, '/').toLowerCase();
      if (!projectMap.has(norm)) {
        projectMap.set(norm, {
          name: path.basename(currentRoot) || 'Current Project',
          path: currentRoot
        });
      }

      // 3. Scan sibling directories in parent folder (e.g. Downloads or workspace root)
      try {
        const parentDir = path.dirname(currentRoot);
        if (parentDir && fs.existsSync(parentDir)) {
          const entries = fs.readdirSync(parentDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
              const fullPath = path.join(parentDir, entry.name);
              if (
                fs.existsSync(path.join(fullPath, 'package.json')) ||
                fs.existsSync(path.join(fullPath, 'Cargo.toml')) ||
                fs.existsSync(path.join(fullPath, '.git')) ||
                fs.existsSync(path.join(fullPath, '.antigravity')) ||
                fs.existsSync(path.join(fullPath, 'pyproject.toml'))
              ) {
                const sNorm = fullPath.replace(/[/\\]+/g, '/').toLowerCase();
                if (!projectMap.has(sNorm)) {
                  projectMap.set(sNorm, {
                    name: entry.name,
                    path: fullPath
                  });
                }
              }
            }
          }
        }
      } catch (_) {}

      // 4. Scan sub-directories in currentRoot (e.g. test-project)
      try {
        if (fs.existsSync(currentRoot)) {
          const subEntries = fs.readdirSync(currentRoot, { withFileTypes: true });
          for (const sub of subEntries) {
            if (sub.isDirectory() && !sub.name.startsWith('.') && sub.name !== 'node_modules' && sub.name !== 'dist' && sub.name !== 'out') {
              const subPath = path.join(currentRoot, sub.name);
              if (
                fs.existsSync(path.join(subPath, 'package.json')) ||
                fs.existsSync(path.join(subPath, '.antigravity'))
              ) {
                const subNorm = subPath.replace(/[/\\]+/g, '/').toLowerCase();
                if (!projectMap.has(subNorm)) {
                  projectMap.set(subNorm, {
                    name: `${path.basename(currentRoot)} / ${sub.name}`,
                    path: subPath
                  });
                }
              }
            }
          }
        }
      } catch (_) {}
    }

    return Array.from(projectMap.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  public static initializeAllWorkspaces(): void {
    const folders = vscode.workspace.workspaceFolders || [];
    for (const folder of folders) {
      try {
        const root = folder.uri.fsPath;
        const dir = path.join(root, '.antigravity');
        const jsonFile = path.join(dir, 'kanban.json');
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        if (!fs.existsSync(jsonFile)) {
          const initialBoard: KanbanBoard = {
            version: '1.0',
            title: folder.name + ' Tasks',
            columns: DEFAULT_COLUMNS,
            cards: [],
            ralphConfig: DEFAULT_RALPH_CONFIG,
            lastUpdated: new Date().toISOString()
          };
          fs.writeFileSync(jsonFile, JSON.stringify(initialBoard, null, 2), 'utf8');
        }
      } catch (err) {
        console.warn(`Could not initialize kanban in ${folder.name}:`, err);
      }
    }
  }

  private ensureDirectoryExists(): void {
    if (!fs.existsSync(this.configDir)) {
      try {
        fs.mkdirSync(this.configDir, { recursive: true });
      } catch (err) {
        console.error('Failed to create .antigravity directory:', err);
      }
    }
  }

  private setupFileWatcher(): void {
    const pattern = new vscode.RelativePattern(this.configDir, '{kanban.json,KANBAN.md}');
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

    this.fileWatcher.onDidChange((uri) => this.handleFileChange(uri));
    this.fileWatcher.onDidCreate((uri) => this.handleFileChange(uri));
  }

  private handleFileChange(uri: vscode.Uri): void {
    if (this.isSaving) {
      return;
    }

    // Debounce to allow write operations to complete
    setTimeout(async () => {
      try {
        const board = await this.loadBoard();
        this.onBoardChangeEmitter.fire(board);
      } catch (err) {
        console.error('Error reloading board from external change:', err);
      }
    }, 150);
  }

  public async loadBoard(): Promise<KanbanBoard> {
    this.ensureDirectoryExists();

    // Prefer JSON if it exists
    if (fs.existsSync(this.jsonPath)) {
      try {
        const raw = fs.readFileSync(this.jsonPath, 'utf8');
        const parsed = JSON.parse(raw) as KanbanBoard;
        let needsMigration = false;

        // Auto-migrate from 5 columns to 3 columns
        if (!parsed.columns || parsed.columns.length !== 3 || parsed.columns[0].id !== 'pending') {
          parsed.columns = DEFAULT_COLUMNS;
          needsMigration = true;
        }

        if (!parsed.features) {
          parsed.features = [];
        }

        if (Array.isArray(parsed.cards)) {
          for (const card of parsed.cards) {
            if (!card.subStories) {
              card.subStories = [];
            }
            if (!card.type) {
              card.type = 'story';
            }
            if (card.columnId === 'backlog' || card.columnId === 'todo') {
              card.columnId = 'pending';
              needsMigration = true;
            } else if (card.columnId === 'in_review') {
              card.columnId = 'in_progress';
              needsMigration = true;
            }
          }
        }

        if (!parsed.ralphConfig) {
          parsed.ralphConfig = DEFAULT_RALPH_CONFIG;
          needsMigration = true;
        }

        if (needsMigration) {
          await this.saveBoard(parsed);
        }

        return parsed;
      } catch (err) {
        console.warn('kanban.json corrupted or invalid, attempting to read KANBAN.md fallback:', err);
      }
    }

    // Fallback: parse Markdown if available
    if (fs.existsSync(this.mdPath)) {
      try {
        const mdContent = fs.readFileSync(this.mdPath, 'utf8');
        const boardFromMd = this.parseMarkdownToBoard(mdContent);
        // Persist the parsed board back to JSON
        await this.saveBoard(boardFromMd);
        return boardFromMd;
      } catch (err) {
        console.warn('Failed to parse KANBAN.md:', err);
      }
    }

    // Initial default board if nothing exists
    const initialBoard: KanbanBoard = {
      version: '1.0',
      title: path.basename(this.workspaceRoot) + ' Tasks',
      columns: DEFAULT_COLUMNS,
      cards: [
        {
          id: 'TASK-001',
          title: 'Review System Architecture & Dependencies',
          description: 'Inspect workspace files, verify package configurations, and identify module interfaces.',
          columnId: 'pending',
          priority: 'high',
          tags: ['architecture', 'setup'],
          model: 'Gemini 3.8 Flash (High)',
          verificationCommand: '',
          acceptanceCriteria: ['Verify workspace structure', 'Document baseline requirements'],
          assignedAgent: 'Ralph',
          iterationCount: 0,
          maxIterations: 5,
          logs: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ],
      ralphConfig: DEFAULT_RALPH_CONFIG,
      lastUpdated: new Date().toISOString()
    };

    await this.saveBoard(initialBoard);
    return initialBoard;
  }

  public async saveBoard(board: KanbanBoard): Promise<void> {
    this.ensureDirectoryExists();
    this.isSaving = true;

    try {
      board.lastUpdated = new Date().toISOString();

      // 1. Save JSON
      const jsonContent = JSON.stringify(board, null, 2);
      fs.writeFileSync(this.jsonPath, jsonContent, 'utf8');

      // 2. Save Markdown
      const mdContent = this.generateMarkdownFromBoard(board);
      fs.writeFileSync(this.mdPath, mdContent, 'utf8');
    } catch (err) {
      console.error('Failed to save Kanban board files:', err);
      throw err;
    } finally {
      // Re-enable watcher after slight delay
      setTimeout(() => {
        this.isSaving = false;
      }, 250);
    }
  }

  public generateMarkdownFromBoard(board: KanbanBoard): string {
    let md = `# ${board.title || 'Project Kanban Board'}\n\n`;
    md += `> **Antigravity Kanban & Ralph Loop State**\n`;
    md += `> Dual-persisted in \`.antigravity/kanban.json\` and \`.antigravity/KANBAN.md\` for human & AI agent collaboration.\n`;
    md += `> **Last Synchronized:** ${board.lastUpdated}\n`;
    md += `> **Active Default Model:** \`${board.ralphConfig?.defaultModel || 'Gemini 3.8 Flash (High)'}\` | **Mode:** \`${board.ralphConfig?.executionMode || 'antigravity'}\`\n\n`;
    md += `---\n\n`;

    if (board.features && board.features.length > 0) {
      md += `## Features & Epics (${board.features.length})\n\n`;
      for (const feat of board.features) {
        const featCards = board.cards.filter(c => c.featureId === feat.id);
        const doneCount = featCards.filter(c => c.columnId === 'done').length;
        const pct = featCards.length > 0 ? Math.round((doneCount / featCards.length) * 100) : 0;
        md += `- **[${feat.id}] ${feat.title}** (${doneCount}/${featCards.length} stories - ${pct}%)\n`;
        if (feat.description) md += `  ${feat.description}\n`;
      }
      md += `\n---\n\n`;
    }

    for (const col of board.columns) {
      const colCards = board.cards.filter(c => c.columnId === col.id);
      md += `## ${col.title} (${colCards.length})\n\n`;

      if (colCards.length === 0) {
        md += `*No tasks in this column.*\n\n`;
        continue;
      }

      for (const card of colCards) {
        const checked = col.id === 'done' ? 'x' : ' ';
        md += `### [${checked}] ${card.id}: ${card.title}\n`;
        
        const feat = card.featureId ? (board.features || []).find(f => f.id === card.featureId) : null;
        if (feat) {
          md += `- **Feature:** \`[${feat.id}] ${feat.title}\` | **Type:** \`${(card.type || 'story').toUpperCase()}\`\n`;
        }
        md += `- **Priority:** \`${card.priority.toUpperCase()}\` | **Tags:** ${card.tags.length > 0 ? card.tags.map(t => `\`#${t}\``).join(' ') : 'none'}\n`;
        if (card.model) {
          md += `- **Assigned Model:** \`${card.model}\`\n`;
        }
        if (card.verificationCommand) {
          md += `- **Verify Command:** \`${card.verificationCommand}\`\n`;
        }
        if (card.iterationCount > 0) {
          md += `- **Ralph Iterations:** ${card.iterationCount} / ${card.maxIterations}\n`;
        }
        md += `\n${card.description.trim()}\n\n`;

        if (card.subStories && card.subStories.length > 0) {
          md += `**Sub-Stories (${card.subStories.filter(s => s.completed).length}/${card.subStories.length}):**\n`;
          for (const sub of card.subStories) {
            const mark = sub.completed ? 'x' : ' ';
            md += `- [${mark}] ${sub.id}: ${sub.title}\n`;
          }
          md += `\n`;
        }

        if (card.acceptanceCriteria && card.acceptanceCriteria.length > 0) {
          md += `**Acceptance Criteria:**\n`;
          for (const crit of card.acceptanceCriteria) {
            md += `- [ ] ${crit}\n`;
          }
          md += `\n`;
        }

        if (card.logs && card.logs.length > 0) {
          const recentLogs = card.logs.slice(-3);
          md += `<details><summary>Recent Ralph Agent Logs (${card.logs.length})</summary>\n\n`;
          for (const l of recentLogs) {
            md += `- \`[${l.timestamp.split('T')[1]?.split('.')[0] || l.timestamp}] [${l.type.toUpperCase()}]\` ${l.message}\n`;
          }
          md += `\n</details>\n\n`;
        }

        md += `---\n\n`;
      }
    }

    return md;
  }

  public parseMarkdownToBoard(md: string): KanbanBoard {
    const board: KanbanBoard = {
      version: '1.0',
      title: 'Project Kanban Board',
      columns: DEFAULT_COLUMNS,
      cards: [],
      ralphConfig: DEFAULT_RALPH_CONFIG,
      lastUpdated: new Date().toISOString()
    };

    const lines = md.split('\n');
    let currentColumnId: ColumnId = 'pending';
    let currentCard: Partial<KanbanCard> | null = null;
    let cardDescriptionLines: string[] = [];
    let inCriteria = false;

    const finalizeCard = () => {
      if (currentCard && currentCard.title) {
        currentCard.description = cardDescriptionLines.join('\n').trim();
        board.cards.push({
          id: currentCard.id || `TASK-${String(board.cards.length + 1).padStart(3, '0')}`,
          title: currentCard.title,
          description: currentCard.description,
          columnId: currentCard.columnId || currentColumnId,
          priority: currentCard.priority || 'medium',
          tags: currentCard.tags || [],
          model: currentCard.model,
          verificationCommand: currentCard.verificationCommand,
          acceptanceCriteria: currentCard.acceptanceCriteria || [],
          iterationCount: currentCard.iterationCount || 0,
          maxIterations: currentCard.maxIterations || 5,
          logs: currentCard.logs || [],
          createdAt: currentCard.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }
      currentCard = null;
      cardDescriptionLines = [];
      inCriteria = false;
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();

      // Check Column Header
      if (rawLine.startsWith('## ')) {
        finalizeCard();
        const lower = rawLine.toLowerCase();
        if (lower.includes('queue') || lower.includes('pending') || lower.includes('backlog') || lower.includes('todo')) currentColumnId = 'pending';
        else if (lower.includes('running') || lower.includes('in progress') || lower.includes('active') || lower.includes('review')) currentColumnId = 'in_progress';
        else if (lower.includes('done') || lower.includes('completed')) currentColumnId = 'done';
        else currentColumnId = 'pending';
        continue;
      }

      // Check Card Header (e.g. ### [ ] TASK-001: My Title)
      if (rawLine.startsWith('### ')) {
        finalizeCard();
        const headerMatch = rawLine.match(/^###\s+\[( |x)\]\s+(?:([A-Z0-9_-]+):\s*)?(.*)$/i);
        if (headerMatch) {
          const isDone = headerMatch[1].toLowerCase() === 'x';
          const cardId = headerMatch[2] || `TASK-${String(board.cards.length + 1).padStart(3, '0')}`;
          const title = headerMatch[3].trim() || 'Untitled Task';
          currentCard = {
            id: cardId,
            title,
            columnId: isDone ? 'done' : currentColumnId,
            tags: [],
            acceptanceCriteria: [],
            logs: []
          };
        }
        continue;
      }

      if (!currentCard) {
        continue;
      }

      // Metadata bullet points
      if (line.startsWith('- **Priority:**')) {
        const pMatch = line.match(/\*\*Priority:\*\*\s*`([A-Z]+)`/i);
        if (pMatch) {
          const val = pMatch[1].toLowerCase() as Priority;
          if (['low', 'medium', 'high', 'urgent'].includes(val)) {
            currentCard.priority = val;
          }
        }
        const tagMatches = line.match(/`#([^`]+)`/g);
        if (tagMatches) {
          currentCard.tags = tagMatches.map(t => t.replace(/[`#]/g, ''));
        }
        continue;
      }

      if (line.startsWith('- **Assigned Model:**')) {
        const mMatch = line.match(/\*\*Assigned Model:\*\*\s*`([^`]+)`/i);
        if (mMatch) {
          currentCard.model = mMatch[1];
        }
        continue;
      }

      if (line.startsWith('- **Verify Command:**')) {
        const vMatch = line.match(/\*\*Verify Command:\*\*\s*`([^`]+)`/i);
        if (vMatch) {
          currentCard.verificationCommand = vMatch[1];
        }
        continue;
      }

      if (line.startsWith('- **Ralph Iterations:**')) {
        const iterMatch = line.match(/\*\*Ralph Iterations:\*\*\s*(\d+)\s*\/\s*(\d+)/i);
        if (iterMatch) {
          currentCard.iterationCount = parseInt(iterMatch[1], 10);
          currentCard.maxIterations = parseInt(iterMatch[2], 10);
        }
        continue;
      }

      if (line.startsWith('**Acceptance Criteria:**')) {
        inCriteria = true;
        continue;
      }

      if (inCriteria && line.startsWith('- [ ]')) {
        const crit = line.substring(5).trim();
        if (crit) {
          currentCard.acceptanceCriteria = currentCard.acceptanceCriteria || [];
          currentCard.acceptanceCriteria.push(crit);
        }
        continue;
      }

      if (line === '---') {
        finalizeCard();
        continue;
      }

      if (line.startsWith('<details') || line.startsWith('</details')) {
        continue;
      }

      // Collect description text
      if (!line.startsWith('- `[')) {
        cardDescriptionLines.push(rawLine);
      }
    }

    finalizeCard();
    return board;
  }

  public dispose(): void {
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
    }
    this.onBoardChangeEmitter.dispose();
  }
}
