import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as https from 'https';
import * as http from 'http';
import * as url from 'url';
import * as path from 'path';
import * as fs from 'fs';
import { KanbanBoard, KanbanCard, RalphLoopStatus, CardLogEntry, ModelOption, ANTIGRAVITY_NATIVE_MODELS, EXTERNAL_MODELS } from '../types/kanban';
import { FileManager } from '../storage/FileManager';

export interface RalphTelemetryEvent {
  status: RalphLoopStatus;
  activeCardId?: string;
  activeCardTitle?: string;
  iteration: number;
  maxIterations: number;
  model: string;
  log: CardLogEntry;
}

export class RalphLoopEngine {
  private workspaceRoot: string;
  private fileManager: FileManager;
  private secretStorage: vscode.SecretStorage;
  private status: RalphLoopStatus = 'idle';
  private activeCard: KanbanCard | null = null;
  private isPaused: boolean = false;
  private isAbortRequested: boolean = false;
  private telemetryEmitter = new vscode.EventEmitter<RalphTelemetryEvent>();
  private statusChangeEmitter = new vscode.EventEmitter<RalphLoopStatus>();

  public readonly onTelemetry = this.telemetryEmitter.event;
  public readonly onStatusChange = this.statusChangeEmitter.event;

  constructor(workspaceRoot: string, fileManager: FileManager, secretStorage: vscode.SecretStorage) {
    this.workspaceRoot = workspaceRoot;
    this.fileManager = fileManager;
    this.secretStorage = secretStorage;
  }

  public setWorkspaceRoot(newRoot: string): void {
    this.workspaceRoot = newRoot;
  }

  public async getAvailableModels(): Promise<ModelOption[]> {
    const models: ModelOption[] = [...ANTIGRAVITY_NATIVE_MODELS];

    // Query vscode.lm dynamically to see if any models are registered in Antigravity
    try {
      if (typeof (vscode as any).lm !== 'undefined' && typeof (vscode as any).lm.selectChatModels === 'function') {
        const lmPromise = (vscode as any).lm.selectChatModels();
        const timeoutPromise = new Promise<any[]>((resolve) => setTimeout(() => resolve([]), 1000));
        const lmModels = await Promise.race([lmPromise, timeoutPromise]);
        if (Array.isArray(lmModels)) {
          for (const m of lmModels) {
            const id = m.id || m.name;
            if (id && !models.some(existing => existing.id === id || existing.name === m.name)) {
              models.push({
                id,
                name: `${m.name || id} [${m.vendor || 'Editor LM'}]`,
                provider: 'antigravity-lm',
                isNative: true,
                description: `Built-in Antigravity model (${m.family || m.id})`
              });
            }
          }
        }
      }
    } catch (_) {}

    // Append external models below
    models.push(...EXTERNAL_MODELS);
    return models;
  }

  public getStatus(): RalphLoopStatus {
    return this.status;
  }

  public getActiveCard(): KanbanCard | null {
    return this.activeCard;
  }

  private setStatus(newStatus: RalphLoopStatus): void {
    this.status = newStatus;
    this.statusChangeEmitter.fire(newStatus);
  }

  private emitLog(card: KanbanCard, type: CardLogEntry['type'], message: string): void {
    const entry: CardLogEntry = {
      timestamp: new Date().toISOString(),
      step: card.iterationCount,
      message,
      type
    };
    card.logs.push(entry);

    this.telemetryEmitter.fire({
      status: this.status,
      activeCardId: card.id,
      activeCardTitle: card.title,
      iteration: card.iterationCount,
      maxIterations: card.maxIterations,
      model: card.model || 'default',
      log: entry
    });
  }

  public async startLoop(cardId?: string): Promise<void> {
    if (this.status === 'running' || this.status === 'verifying') {
      vscode.window.showInformationMessage('Ralph Loop is already running.');
      return;
    }

    this.isPaused = false;
    this.isAbortRequested = false;
    this.setStatus('running');

    try {
      const board = await this.fileManager.loadBoard();

      let targetCard: KanbanCard | undefined;
      if (cardId) {
        targetCard = board.cards.find(c => c.id === cardId);
      }

      if (!targetCard) {
        // Pick card currently In Progress, or first in Queue (pending)
        targetCard = board.cards.find(c => c.columnId === 'in_progress') || 
                     board.cards.find(c => c.columnId === 'pending' || c.columnId === 'todo');
      }

      if (!targetCard) {
        this.setStatus('idle');
        vscode.window.showInformationMessage('No tasks waiting in Queue or Running.');
        return;
      }

      await this.runLoopOnTask(board, targetCard);
    } catch (err: any) {
      this.setStatus('error');
      vscode.window.showErrorMessage(`Ralph Loop encountered an error: ${err.message || err}`);
    }
  }

  public pauseLoop(): void {
    if (this.status === 'running' || this.status === 'verifying') {
      this.isPaused = true;
      this.setStatus('paused');
      if (this.activeCard) {
        this.emitLog(this.activeCard, 'info', '[ralph] Paused by operator.');
      }
    }
  }

  public stopLoop(): void {
    this.isAbortRequested = true;
    this.isPaused = false;
    this.setStatus('idle');
    if (this.activeCard) {
      this.emitLog(this.activeCard, 'info', '[ralph] Halted by operator.');
    }
    this.activeCard = null;
  }

  private async runLoopOnTask(board: KanbanBoard, card: KanbanCard): Promise<void> {
    this.activeCard = card;
    const modelId = card.model || board.ralphConfig?.defaultModel || 'Gemini 3.8 Flash (High)';
    const maxIter = card.maxIterations || board.ralphConfig.maxIterations || 5;

    // Move to in_progress if in pending or todo
    if (card.columnId === 'pending' || card.columnId === 'todo') {
      card.columnId = 'in_progress';
      card.updatedAt = new Date().toISOString();
      await this.fileManager.saveBoard(board);
    }

    this.emitLog(card, 'info', `[ralph] Starting loop on [${card.id}] using model: ${modelId}`);

    while (!this.isAbortRequested && !this.isPaused) {
      if (card.iterationCount >= maxIter) {
        this.emitLog(card, 'error', `[ralph] Reached maximum iterations (${maxIter}). Pausing for operator review.`);
        this.setStatus('paused');
        await this.fileManager.saveBoard(board);
        return;
      }

      card.iterationCount++;
      card.updatedAt = new Date().toISOString();
      this.emitLog(card, 'info', `--- Iteration ${card.iterationCount} of ${maxIter} ---`);

      // 1. Model Step Execution
      try {
        const isAntigravity = ['Planning', 'Fast', 'Pseudo-Ralph', 'antigravity'].includes(board.ralphConfig.executionMode) ||
                              ANTIGRAVITY_NATIVE_MODELS.some(m => m.id === modelId) ||
                              modelId.toLowerCase().includes('thinking') ||
                              modelId.toLowerCase().includes('gemini 3') ||
                              modelId.toLowerCase().includes('claude 4') ||
                              modelId.toLowerCase().includes('gpt-oss');

        if (board.ralphConfig.executionMode === 'terminal-agent' || modelId === 'terminal-agent') {
          await this.executeViaTerminalAgent(card);
        } else if (isAntigravity) {
          await this.executeViaAntigravityNative(card, modelId, board);
        } else {
          await this.executeViaDirectApi(card, modelId, board);
        }
      } catch (err: any) {
        this.emitLog(card, 'error', `[llm] Invocation failure: ${err.message || err}`);
        this.setStatus('error');
        await this.fileManager.saveBoard(board);
        return;
      }

      // Check if paused or stopped during model invocation
      if (this.isAbortRequested || this.isPaused) {
        await this.fileManager.saveBoard(board);
        return;
      }

      // 2. Automated Verification Step
      const verifyCmd = card.verificationCommand || board.ralphConfig.defaultVerificationCommand;
      if (verifyCmd && verifyCmd.trim().length > 0) {
        this.setStatus('verifying');
        this.emitLog(card, 'verify', `[verify] Running command: \`${verifyCmd}\`...`);

        const verifyResult = await this.runVerificationCommand(verifyCmd);
        if (verifyResult.success) {
          this.emitLog(card, 'success', `[verify] Succeeded: ${verifyResult.summary}`);
          
          // Check if card has sub-stories to mark progress
          if (card.subStories && card.subStories.length > 0) {
            const nextSub = card.subStories.find(s => !s.completed);
            if (nextSub) {
              nextSub.completed = true;
              this.emitLog(card, 'success', `[sub-story] Completed: "${nextSub.title}"`);
            }
            const remaining = card.subStories.filter(s => !s.completed);
            if (remaining.length > 0) {
              const doneCount = card.subStories.length - remaining.length;
              this.emitLog(card, 'info', `[sub-story] Progress: ${doneCount}/${card.subStories.length} sub-stories complete. Continuing to next sub-story...`);
              card.updatedAt = new Date().toISOString();
              await this.fileManager.saveBoard(board);
              // Delay before starting next sub-story iteration
              await new Promise(resolve => setTimeout(resolve, 2000));
              continue;
            }
          }

          // Transition to Completed (done)
          card.columnId = 'done';
          card.completedAt = new Date().toISOString();
          card.updatedAt = new Date().toISOString();
          await this.fileManager.saveBoard(board);

          this.setStatus('completed');
          vscode.window.showInformationMessage(`Story [${card.id}] "${card.title}" verified and completed!`);

          // Auto-advance to next task if enabled
          if (board.ralphConfig.autoAdvance) {
            const nextCard = board.cards.find(c => c.columnId === 'pending' || c.columnId === 'todo');
            if (nextCard) {
              this.emitLog(card, 'info', `[ralph] Auto-advancing to next task: [${nextCard.id}] "${nextCard.title}"`);
              await this.runLoopOnTask(board, nextCard);
            } else {
              this.setStatus('idle');
              this.activeCard = null;
            }
          } else {
            this.setStatus('idle');
            this.activeCard = null;
          }
          return;
        } else if (verifyResult.isEnvError) {
          this.emitLog(card, 'error', `[verify] Environment Tool Missing: ${verifyResult.summary}`);
          this.emitLog(card, 'error', `[ralph] Paused loop to prevent burning iterations. Please install the CLI tool or update the verification command in task settings.`);
          this.setStatus('paused');
          vscode.window.showErrorMessage(`Ralph Loop Paused: Command tool for '${verifyCmd}' was not found on your system PATH.`);
          await this.fileManager.saveBoard(board);
          return;
        } else {
          this.emitLog(card, 'error', `[verify] Failed (Exit code: ${verifyResult.exitCode}): ${verifyResult.summary}`);
          this.emitLog(card, 'info', `[ralph] Refining prompt with test failure logs for next iteration...`);
        }
      } else {
        // No verification command specified: complete card & all sub-stories, then auto-advance
        if (card.subStories && card.subStories.length > 0) {
          card.subStories.forEach(s => s.completed = true);
          this.emitLog(card, 'success', `[sub-story] Marked all sub-stories complete.`);
        }
        this.emitLog(card, 'success', `[ralph] Task completed (no validation command required). Moving to Completed.`);
        card.columnId = 'done';
        card.completedAt = new Date().toISOString();
        card.updatedAt = new Date().toISOString();
        await this.fileManager.saveBoard(board);
        this.setStatus('completed');
        vscode.window.showInformationMessage(`Story [${card.id}] "${card.title}" completed!`);

        if (board.ralphConfig.autoAdvance) {
          const nextCard = board.cards.find(c => c.columnId === 'pending' || c.columnId === 'todo');
          if (nextCard) {
            this.emitLog(card, 'info', `[ralph] Auto-advancing to next task: [${nextCard.id}] "${nextCard.title}"`);
            await this.runLoopOnTask(board, nextCard);
          } else {
            this.setStatus('idle');
            this.activeCard = null;
          }
        } else {
          this.setStatus('idle');
          this.activeCard = null;
        }
        return;
      }

      await this.fileManager.saveBoard(board);
      // Brief delay between iterations
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    await this.fileManager.saveBoard(board);
  }

  
  public async stageTaskForAgent(card: KanbanCard, board: KanbanBoard): Promise<void> {
    try {
      const docsTasksDir = path.join(this.workspaceRoot, 'docs', 'tasks');
      if (!fs.existsSync(docsTasksDir)) {
        fs.mkdirSync(docsTasksDir, { recursive: true });
      }
      const taskContent = `# Current Active Task\n\n## [ ] ${card.id}: ${card.title}\n${card.description}\n\n### Acceptance Criteria:\n${card.acceptanceCriteria.map(c => `- [ ] ${c}`).join('\n')}\n`;
      fs.writeFileSync(path.join(docsTasksDir, 'tasks.md'), taskContent, 'utf8');

      const promptContent = this.buildTaskPrompt(card, board);
      fs.writeFileSync(path.join(docsTasksDir, 'prompt.md'), promptContent, 'utf8');
      this.emitLog(card, 'info', `Synced task to docs/tasks/tasks.md and docs/tasks/prompt.md for Antigravity Agent.`);
    } catch (e) {
      console.warn('Could not write docs/tasks:', e);
    }
  }

  private async executeViaAntigravityNative(card: KanbanCard, modelId: string, board: KanbanBoard): Promise<void> {
    this.emitLog(card, 'model', `Connecting to Antigravity native model: ${modelId}...`);

    // 1. Synchronize Antigravity's ralphLoop configuration if available
    try {
      const ralphCfg = vscode.workspace.getConfiguration('ralphLoop');
      if (ralphCfg) {
        await ralphCfg.update('defaultModel', modelId, vscode.ConfigurationTarget.Global);
        const mode = board.ralphConfig.executionMode === 'Fast' ? 'Fast' : 'Planning';
        await ralphCfg.update('defaultMode', mode, vscode.ConfigurationTarget.Global);
      }
      const ralphCoreCfg = vscode.workspace.getConfiguration('ralph');
      if (ralphCoreCfg) {
        const isPseudo = board.ralphConfig.executionMode === 'Pseudo-Ralph';
        await ralphCoreCfg.update('pseudoRalphMode', isPseudo, vscode.ConfigurationTarget.Global);
      }
    } catch (_) {}

    // 2. Prepare task file for Antigravity Agent
    await this.stageTaskForAgent(card, board);

    // 3. Try to use VS Code / Antigravity Language Model API (vscode.lm)
    let executedViaLm = false;
    try {
      if (typeof (vscode as any).lm !== 'undefined') {
        const chatModels = await (vscode as any).lm.selectChatModels();
        if (Array.isArray(chatModels) && chatModels.length > 0) {
          const matched = chatModels.find((m: any) => 
            m.id === modelId || 
            m.name === modelId || 
            (m.family && modelId.toLowerCase().includes(m.family.toLowerCase()))
          ) || chatModels[0];

          if (matched) {
            this.emitLog(card, 'model', `Streaming from Antigravity Language Model: ${matched.name || matched.id}...`);
            const prompt = this.buildTaskPrompt(card, board);
            const messages = [(vscode as any).LanguageModelChatMessage.User(prompt)];
            const response = await matched.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
            
            let responseText = '';
            for await (const chunk of response.text) {
              responseText += chunk;
            }
            if (responseText) {
              const preview = responseText.length > 250 ? responseText.substring(0, 250) + '...' : responseText;
              this.emitLog(card, 'model', `[model] Output preview: ${preview}`);
              executedViaLm = true;
            }
          }
        }
      }
    } catch (lmErr: any) {
      this.emitLog(card, 'info', `Antigravity LM session: ${lmErr.message || lmErr}`);
    }

    // 4. If Antigravity Ralph extension command is registered, trigger it or prompt agent
    if (!executedViaLm) {
      try {
        const allCommands = await vscode.commands.getCommands(true);
        if (allCommands.includes('ralph.start')) {
          this.emitLog(card, 'tool', `Triggering Antigravity Ralph Loop runner (ralph.start)...`);
          await vscode.commands.executeCommand('ralph.start');
          this.emitLog(card, 'info', `Ralph Loop started in Antigravity. Monitoring agent activity...`);
          await this.waitForAgentExecution(card);
        } else {
          this.emitLog(card, 'info', `Task staged in Antigravity. Model: ${modelId}. Ready for agent execution.`);
        }
      } catch (cmdErr: any) {
        this.emitLog(card, 'info', `Task staged in Antigravity: ${card.title}`);
      }
    }
  }

  private async executeViaDirectApi(card: KanbanCard, modelId: string, board: KanbanBoard): Promise<void> {
    const modelMeta = AVAILABLE_MODELS.find(m => m.id === modelId) || { provider: 'anthropic', id: modelId, name: modelId };
    
    // Build context prompt
    const prompt = this.buildTaskPrompt(card, board);
    this.emitLog(card, 'model', `Calling ${modelMeta.name}...`);

    let responseText = '';

    switch (modelMeta.provider) {
      case 'anthropic': {
        const apiKey = (await this.secretStorage.get('anthropicApiKey')) || process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          throw new Error('Anthropic API key not configured. Add it in Kanban Settings or set ANTHROPIC_API_KEY.');
        }
        responseText = await this.callAnthropicApi(apiKey, modelId, prompt);
        break;
      }
      case 'openai': {
        const apiKey = (await this.secretStorage.get('openaiApiKey')) || process.env.OPENAI_API_KEY;
        if (!apiKey) {
          throw new Error('OpenAI API key not configured. Add it in Kanban Settings or set OPENAI_API_KEY.');
        }
        responseText = await this.callOpenAiApi('https://api.openai.com/v1/chat/completions', apiKey, modelId, prompt);
        break;
      }
      case 'gemini': {
        const apiKey = (await this.secretStorage.get('geminiApiKey')) || process.env.GEMINI_API_KEY;
        if (!apiKey) {
          throw new Error('Gemini API key not configured. Add it in Kanban Settings or set GEMINI_API_KEY.');
        }
        responseText = await this.callGeminiApi(apiKey, modelId, prompt);
        break;
      }
      case 'deepseek': {
        const apiKey = (await this.secretStorage.get('deepseekApiKey')) || process.env.DEEPSEEK_API_KEY;
        if (!apiKey) {
          throw new Error('DeepSeek API key not configured. Add it in Kanban Settings or set DEEPSEEK_API_KEY.');
        }
        const endpoint = board.ralphConfig.customApiEndpoint || 'https://api.deepseek.com/v1';
        responseText = await this.callOpenAiApi(`${endpoint}/chat/completions`, apiKey, modelId, prompt);
        break;
      }
      case 'ollama': {
        const endpoint = board.ralphConfig.ollamaEndpoint || 'http://127.0.0.1:11434';
        responseText = await this.callOllamaApi(endpoint, 'llama3.2', prompt);
        break;
      }
      case 'custom': {
        const apiKey = (await this.secretStorage.get('customApiKey')) || 'sk-custom';
        const endpoint = board.ralphConfig.customApiEndpoint || 'https://api.openai.com/v1';
        responseText = await this.callOpenAiApi(`${endpoint}/chat/completions`, apiKey, modelId, prompt);
        break;
      }
      default:
        throw new Error(`Unsupported model provider: ${modelMeta.provider}`);
    }

    const preview = responseText.length > 250 ? responseText.substring(0, 250) + '...' : responseText;
    this.emitLog(card, 'model', `💡 Response received: ${preview}`);
  }

  private async executeViaTerminalAgent(card: KanbanCard): Promise<void> {
    const terminalName = 'Antigravity Ralph Agent';
    let term = vscode.window.terminals.find(t => t.name === terminalName);
    if (!term) {
      term = vscode.window.createTerminal(terminalName);
    }
    term.show(true);

    const promptText = `[Ralph Task ${card.id}]: ${card.title}. Objective: ${card.description}`;
    this.emitLog(card, 'tool', `Sent task prompt to Antigravity Integrated Terminal.`);
    term.sendText(`# Ralph Loop Step: ${card.id}`);
    term.sendText(`echo "Ralph Autonomous Agent executing: ${card.title}"`);
    
    // Wait for operator or mock step
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  private buildTaskPrompt(card: KanbanCard, board?: KanbanBoard): string {
    let p = `You are the Ralph Autonomous Loop Agent in Antigravity IDE.\n`;
    if (board && card.featureId) {
      const feat = (board.features || []).find(f => f.id === card.featureId);
      if (feat) {
        p += `Feature/Epic: [${feat.id}] ${feat.title}\n`;
      }
    }
    p += `Story/Task: [${card.id}] "${card.title}"\n`;
    p += `Type: ${(card.type || 'story').toUpperCase()} | Priority: ${card.priority}\n\n`;
    p += `Objective / Description:\n${card.description}\n\n`;

    if (card.subStories && card.subStories.length > 0) {
      p += `Sub-Stories & Tasks:\n`;
      for (const sub of card.subStories) {
        const mark = sub.completed ? '[x]' : '[ ]';
        p += `- ${mark} ${sub.id}: ${sub.title}\n`;
      }
      p += `\n`;
    }

    if (card.acceptanceCriteria && card.acceptanceCriteria.length > 0) {
      p += `Acceptance Criteria:\n`;
      for (const crit of card.acceptanceCriteria) {
        p += `- [ ] ${crit}\n`;
      }
      p += `\n`;
    }

    if (card.logs && card.logs.length > 0) {
      const recentErrors = card.logs.filter(l => l.type === 'error').slice(-2);
      if (recentErrors.length > 0) {
        p += `Previous Test/Verification Errors to Fix:\n`;
        for (const err of recentErrors) {
          p += `- ${err.message}\n`;
        }
        p += `\n`;
      }
    }

    p += `Provide concise, actionable implementation steps or code to satisfy all acceptance criteria.`;
    return p;
  }

  private async waitForAgentExecution(card: KanbanCard): Promise<void> {
    const progressFile = path.join(this.workspaceRoot, 'docs', 'tasks', 'progress.txt');
    let initialMtime = 0;
    try {
      if (fs.existsSync(progressFile)) {
        initialMtime = fs.statSync(progressFile).mtimeMs;
      }
    } catch (_) {}

    const maxWaitMs = 15000;
    const intervalMs = 2500;
    let elapsed = 0;
    while (elapsed < maxWaitMs && !this.isAbortRequested && !this.isPaused) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));
      elapsed += intervalMs;
      try {
        if (fs.existsSync(progressFile)) {
          const currentMtime = fs.statSync(progressFile).mtimeMs;
          if (currentMtime > initialMtime) {
            this.emitLog(card, 'tool', `[agent] Detected activity in progress.txt.`);
            break;
          }
        }
      } catch (_) {}
    }
  }

  private runVerificationCommand(command: string): Promise<{ success: boolean; exitCode: number; summary: string; isEnvError?: boolean }> {
    return new Promise((resolve) => {
      const env = { ...process.env };
      const home = process.env.USERPROFILE || process.env.HOME || '';
      if (home) {
        const cargoBin = path.join(home, '.cargo', 'bin');
        if (fs.existsSync(cargoBin) && !(env.PATH || '').includes(cargoBin)) {
          env.PATH = `${cargoBin};${env.PATH || ''}`;
        }
      }

      cp.exec(command, { cwd: this.workspaceRoot, env, timeout: 60000 }, (error, stdout, stderr) => {
        const exitCode = error ? (error.code ?? 1) : 0;
        const outText = (stdout || '').trim();
        const errText = (stderr || '').trim();
        const combined = outText ? (errText ? `${outText}\n${errText}` : outText) : errText || 'No output';
        const lines = combined.split('\n');
        const summary = lines.slice(-5).join('; ');

        const lower = combined.toLowerCase();
        const isEnvError = lower.includes('is not recognized as an internal or external command') ||
                           lower.includes('command not found') ||
                           lower.includes('cannot find the path specified') ||
                           (lower.includes('the term') && lower.includes('is not recognized as the name of a cmdlet')) ||
                           lower.includes('no such file or directory');

        resolve({
          success: exitCode === 0,
          exitCode,
          summary: summary.substring(0, 300),
          isEnvError
        });
      });
    });
  }

  // --- HTTP LLM Adapters ---

  private callAnthropicApi(apiKey: string, model: string, prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const actualModel = model.includes('claude-3-7') ? 'claude-3-7-sonnet-20250219' : 'claude-3-5-sonnet-20241022';
      const postData = JSON.stringify({
        model: actualModel,
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      });

      const options = {
        hostname: 'api.anthropic.com',
        port: 443,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(body);
              const text = parsed.content?.[0]?.text || '';
              resolve(text);
            } catch (e) {
              reject(new Error(`Failed to parse Anthropic response: ${body}`));
            }
          } else {
            reject(new Error(`Anthropic API error (${res.statusCode}): ${body}`));
          }
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  private callOpenAiApi(endpointUrl: string, apiKey: string, model: string, prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new url.URL(endpointUrl);
      const postData = JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1500
      });

      const isHttps = parsedUrl.protocol === 'https:';
      const lib = isHttps ? https : http;

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = lib.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(body);
              const text = parsed.choices?.[0]?.message?.content || '';
              resolve(text);
            } catch (e) {
              reject(new Error(`Failed to parse response: ${body}`));
            }
          } else {
            reject(new Error(`OpenAI-compatible API error (${res.statusCode}): ${body}`));
          }
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  private callGeminiApi(apiKey: string, model: string, prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const modelName = model.includes('2.0-pro') ? 'gemini-2.0-pro-exp-02-05' : 'gemini-2.0-flash';
      const postData = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      });

      const options = {
        hostname: 'generativelanguage.googleapis.com',
        port: 443,
        path: `/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(body);
              const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
              resolve(text);
            } catch (e) {
              reject(new Error(`Failed to parse Gemini response: ${body}`));
            }
          } else {
            reject(new Error(`Gemini API error (${res.statusCode}): ${body}`));
          }
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  private callOllamaApi(endpoint: string, model: string, prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new url.URL(endpoint);
      const postData = JSON.stringify({
        model,
        prompt,
        stream: false
      });

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 11434,
        path: '/api/generate',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = http.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(body);
              resolve(parsed.response || '');
            } catch (e) {
              reject(new Error(`Failed to parse Ollama response: ${body}`));
            }
          } else {
            reject(new Error(`Ollama API error (${res.statusCode}): ${body}`));
          }
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }
}
