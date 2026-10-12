export type ColumnId = 'pending' | 'in_progress' | 'done' | 'backlog' | 'todo' | 'in_review';

export type Priority = 'low' | 'medium' | 'high' | 'urgent';

export type ModelProvider = 'antigravity' | 'antigravity-lm' | 'anthropic' | 'openai' | 'gemini' | 'deepseek' | 'ollama' | 'custom' | 'terminal';

export interface ModelOption {
  id: string;
  name: string;
  provider: ModelProvider;
  contextWindow?: number;
  description?: string;
  isNative?: boolean;
}

export interface CardLogEntry {
  timestamp: string;
  step: number;
  message: string;
  type: 'info' | 'model' | 'tool' | 'verify' | 'error' | 'success';
}

export type ItemType = 'story' | 'task' | 'bug' | 'feature';

export interface SubStory {
  id: string;
  title: string;
  completed: boolean;
  verificationCommand?: string;
}

export interface KanbanFeature {
  id: string;
  title: string;
  description?: string;
  color?: string;
  status?: 'active' | 'completed' | 'archived';
}

export interface KanbanCard {
  id: string;
  title: string;
  description: string;
  columnId: ColumnId;
  priority: Priority;
  tags: string[];
  type?: ItemType;
  featureId?: string;
  subStories?: SubStory[];
  model?: string;
  verificationCommand?: string;
  acceptanceCriteria: string[];
  assignedAgent?: string;
  iterationCount: number;
  maxIterations: number;
  logs: CardLogEntry[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface KanbanColumn {
  id: ColumnId;
  title: string;
  order: number;
  color?: string;
}

export type RalphLoopStatus = 'idle' | 'running' | 'paused' | 'verifying' | 'error' | 'completed';

export type ExecutionMode = 'Planning' | 'Fast' | 'Pseudo-Ralph' | 'antigravity' | 'direct-api' | 'terminal-agent';

export interface RalphLoopConfig {
  defaultModel: string;
  executionMode: ExecutionMode;
  maxIterations: number;
  defaultVerificationCommand: string;
  autoAdvance: boolean;
  ollamaEndpoint: string;
  customApiEndpoint: string;
}

export interface KanbanBoard {
  version: string;
  title: string;
  features?: KanbanFeature[];
  columns: KanbanColumn[];
  cards: KanbanCard[];
  ralphConfig: RalphLoopConfig;
  lastUpdated: string;
}

export const DEFAULT_COLUMNS: KanbanColumn[] = [
  { id: 'pending', title: 'Queue', order: 0, color: '#64748b' },
  { id: 'in_progress', title: 'Running', order: 1, color: '#f59e0b' },
  { id: 'done', title: 'Completed', order: 2, color: '#10b981' }
];

// Native Antigravity Code Editor Models (Latest Generation)
export const ANTIGRAVITY_NATIVE_MODELS: ModelOption[] = [
  { id: 'Gemini 3.8 Flash (High)', name: 'Gemini 3.8 Flash (High)', provider: 'antigravity', isNative: true, description: 'Latest Antigravity 3.8 flagship high-reasoning model' },
  { id: 'Gemini 3.8 Flash (Medium)', name: 'Gemini 3.8 Flash (Medium)', provider: 'antigravity', isNative: true, description: 'Latest Antigravity 3.8 balanced reasoning model' },
  { id: 'Gemini 3.8 Flash (Low)', name: 'Gemini 3.8 Flash (Low)', provider: 'antigravity', isNative: true, description: 'Latest Antigravity 3.8 ultra-fast streaming model' },
  { id: 'Gemini 3.8 Flash', name: 'Gemini 3.8 Flash', provider: 'antigravity', isNative: true, description: 'Latest Antigravity 3.8 low-latency model' },
  { id: 'Claude Opus 4.6 (Thinking)', name: 'Claude Opus 4.6 (Thinking)', provider: 'antigravity', isNative: true, description: 'Antigravity deep reasoning & architectural agent' },
  { id: 'Claude Sonnet 4.6 (Thinking)', name: 'Claude Sonnet 4.6 (Thinking)', provider: 'antigravity', isNative: true, description: 'Antigravity fast thinking & coding agent' },
  { id: 'Claude 4.5 Sonnet', name: 'Claude 4.5 Sonnet', provider: 'antigravity', isNative: true, description: 'Antigravity complex coding & refactoring model' },
  { id: 'Claude 4.5 Opus', name: 'Claude 4.5 Opus', provider: 'antigravity', isNative: true, description: 'Antigravity advanced autonomous planning model' },
  { id: 'Gemini 3.6 Flash (High)', name: 'Gemini 3.6 Flash (High)', provider: 'antigravity', isNative: true, description: 'Antigravity 3.6 high-reasoning model' },
  { id: 'Gemini 3.6 Flash (Medium)', name: 'Gemini 3.6 Flash (Medium)', provider: 'antigravity', isNative: true, description: 'Antigravity 3.6 balanced model' },
  { id: 'Gemini 3.6 Flash (Low)', name: 'Gemini 3.6 Flash (Low)', provider: 'antigravity', isNative: true, description: 'Antigravity 3.6 streaming model' },
  { id: 'Gemini 3.1 Pro (High)', name: 'Gemini 3.1 Pro (High)', provider: 'antigravity', isNative: true, description: 'Antigravity Gemini 3.1 high reasoning' },
  { id: 'Gemini 3.1 Pro (Low)', name: 'Gemini 3.1 Pro (Low)', provider: 'antigravity', isNative: true, description: 'Antigravity Gemini 3.1 low latency' },
  { id: 'Gemini 3.1 Flash Lite', name: 'Gemini 3.1 Flash Lite', provider: 'antigravity', isNative: true, description: 'Antigravity lightweight token stream' },
  { id: 'Gemini 3 Flash', name: 'Gemini 3 Flash', provider: 'antigravity', isNative: true, description: 'Antigravity native flash model' },
  { id: 'GPT-OSS 120B (Medium)', name: 'GPT-OSS 120B (Medium)', provider: 'antigravity', isNative: true, description: 'Antigravity native open-weights reasoning model' },
  { id: 'Claude 3.7 Sonnet (Thinking)', name: 'Claude 3.7 Sonnet (Thinking)', provider: 'antigravity', isNative: true, description: 'Antigravity hybrid reasoning' },
  { id: 'Claude 3.5 Sonnet', name: 'Claude 3.5 Sonnet', provider: 'antigravity', isNative: true, description: 'Antigravity fast coding agent' },
  { id: 'Gemini 2.5 Pro', name: 'Gemini 2.5 Pro', provider: 'antigravity', isNative: true, description: 'Antigravity large context window' },
  { id: 'Gemini 2.5 Flash', name: 'Gemini 2.5 Flash', provider: 'antigravity', isNative: true, description: 'Antigravity fast streaming' }
];

export const EXTERNAL_MODELS: ModelOption[] = [
  { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet (Anthropic API)', provider: 'anthropic', description: 'External Anthropic API' },
  { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet (Anthropic API)', provider: 'anthropic', description: 'External Anthropic API' },
  { id: 'gpt-4o', name: 'GPT-4o (OpenAI API)', provider: 'openai', description: 'External OpenAI API' },
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash (Google AI Studio)', provider: 'gemini', description: 'External Google API' },
  { id: 'deepseek-r1', name: 'DeepSeek R1 (DeepSeek API)', provider: 'deepseek', description: 'External DeepSeek API' },
  { id: 'ollama-local', name: 'Ollama Local (Local Host)', provider: 'ollama', description: 'Private local Ollama instance' },
  { id: 'terminal-agent', name: 'Antigravity Terminal CLI Agent', provider: 'terminal', description: 'Dispatches into Antigravity terminal' }
];

export const AVAILABLE_MODELS: ModelOption[] = [
  ...ANTIGRAVITY_NATIVE_MODELS,
  ...EXTERNAL_MODELS
];

export const DEFAULT_RALPH_CONFIG: RalphLoopConfig = {
  defaultModel: 'Gemini 3.8 Flash (High)',
  executionMode: 'Planning',
  maxIterations: 5,
  defaultVerificationCommand: '',
  autoAdvance: true,
  ollamaEndpoint: 'http://127.0.0.1:11434',
  customApiEndpoint: 'https://api.deepseek.com/v1'
};
