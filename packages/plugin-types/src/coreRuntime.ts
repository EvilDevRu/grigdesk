import type { ProjectDetail, ProjectSummary } from '../../../shared/runtime/projectsContracts.ts';
import type { SandboxOverview } from '../../../shared/plugins/sandboxes/sandboxContracts.ts';

export interface PluginModelRef {
  provider: string;
  model: string;
  effort?: string | null;
}

export interface PluginModelReceipt {
  resolvedRef: { provider: string; model: string };
  effort: string | null;
  reportedModel: string | null;
  modelEvidence: 'executor_reported';
  cost: number | null;
}

export interface PluginModelTextInput {
  modelRef: PluginModelRef;
  message: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  beforeCall?: () => void;
  onReceipt?: (receipt: PluginModelReceipt) => void;
}

export interface PluginSandboxLease {
  assertHeld(): void;
  assertPathIdentity(): Promise<void>;
  release(): Promise<void>;
}

export interface PluginDirectoryLock {
  release(): Promise<void>;
}

export interface PluginEnvironment {
  runtimeRoot: string;
  defaultLibraryDir: string;
  protectedDirs: readonly string[];
  nodeExecutable: string;
}

// Возможности серверного core v1. Типы не раскрывают config, executor или fd.
// Доступность проверяется по методам: старые сборки могут не иметь расширения.
export interface PluginRuntimeServices {
  project(id: string): Promise<ProjectDetail>;
  listProjects(): Promise<ProjectSummary[]>;
  environment(): Readonly<PluginEnvironment>;
  sandboxes(): Promise<SandboxOverview>;
  holdSandbox(task: string): Promise<PluginSandboxLease>;
  readSourceText(root: string, relative: string, limit: number): Promise<string | null>;
  validateModel(ref: PluginModelRef): Promise<{
    ref: { provider: string; model: string };
    effort: string | null;
  }>;
  modelText(input: PluginModelTextInput): Promise<{ reply: string } & PluginModelReceipt>;
  lock(directory: string): Promise<PluginDirectoryLock>;
  digest(value: unknown): string;
}
