// Исполняемый контракт графового маршрута: одни байты для редактора, Go и ответов API.
// Бизнес-валидация принадлежит Go; типы описывают форму документов и проекций без дефолтов.

export type WorkflowInputKind = 'documents' | 'transcript';

export type WorkflowStepKind =
  | 'input'
  | 'sections'
  | 'agent'
  | 'meetingTasks'
  | 'forEach'
  | 'call'
  | 'repeat'
  | 'join'
  | 'approval';

export type WorkflowJoinMode = 'all' | 'any' | 'quorum';

export const WORKFLOW_MAX_BRANCH_PARALLELISM = 256;

export interface WorkflowCondition {
  source: string;
  test: 'empty' | 'nonempty';
}

export interface WorkflowScope {
  steps: WorkflowStep[];
  returns: string[];
}

export interface WorkflowStep {
  id: string;
  title: string;
  kind: WorkflowStepKind;
  needs?: string[];
  reads?: string[];
  when?: WorkflowCondition;
  source?: string;
  scope?: WorkflowScope;
  prompt?: string;
  mode?: WorkflowJoinMode;
  minSuccess?: number;
  parallelism?: number;
  maxRounds?: number;
  retryFrom?: string[];
}

export interface Workflow {
  title: string;
  inputKind: WorkflowInputKind;
  scope: WorkflowScope;
}

export interface WorkflowSource {
  inputKey: string;
  line: number;
  timeMs?: number;
}

export interface WorkflowRow {
  key: string;
  title: string;
  text: string;
  sources?: WorkflowSource[];
}

export interface WorkflowModelRef {
  provider: string;
  model: string;
  effort?: string;
}

export type WorkflowRunStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'done'
  | 'failed'
  | 'rejected'
  | 'unavailable';

export type WorkflowNodeStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'blocked';

export interface WorkflowNodeCounts {
  total: number;
  done: number;
  running: number;
  failed: number;
}

export interface WorkflowNodeView {
  id: string;
  parent: string;
  title: string;
  kind: WorkflowStepKind;
  status: WorkflowNodeStatus;
  generation: number;
  after: string[];
  members: string[];
  slot: number;
  outputs?: string[];
  errorCode?: string;
  counts?: WorkflowNodeCounts;
}

export interface WorkflowRunGraph {
  id: string;
  title: string;
  templateId: string;
  revision: number;
  status: WorkflowRunStatus;
  nodes: WorkflowNodeView[];
}

export interface WorkflowResultApproval {
  state: 'pending' | 'approved' | 'rejected';
  nodeId: string;
  generation: number;
  comment?: string;
}

export interface WorkflowResult {
  revision: number;
  incomplete: boolean;
  nextCursor: string | null;
  inputs: Array<{ key: string; name: string }>;
  rows: WorkflowRow[];
  missing: Array<{ nodeId: string; errorCode?: string }>;
  approvals: WorkflowResultApproval[];
}