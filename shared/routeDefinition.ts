// Чистые формы route-v2. Проверка семантики остаётся у server/schema и движка.

export interface RouteWhen {
  context: string;
  equals: string | number | boolean | null;
}

export interface RoutePromptBlock {
  file: string;
  when?: RouteWhen;
}

export interface RoutePrompt {
  blocks: RoutePromptBlock[];
  requiredContext: string[];
}

export interface RoutePolicy {
  filesystem: string;
  timeoutClass?: string;
  budgetClass?: string;
  browser?: string;
}

export interface RouteFanout {
  mode: string;
  maxExecutors: number;
  degrade: string;
}

export interface RouteRetry {
  noResult: number;
  productFailure: number;
  providerFailure: { attempts: number; strategy: string };
}

export interface RouteTransitionDoc {
  next?: string;
  rewind?: string;
  reset?: string[];
  stop?: string;
  escalate?: { routes: string[] };
}

export interface RouteNodeDoc {
  id: string;
  executor: string;
  phase: string;
  label?: string;
  description?: string;
  runKey?: string;
  key?: string;
  owner?: string;
  emits?: string[];
  commandId?: string;
  prompt?: RoutePrompt;
  policy?: RoutePolicy;
  fanout?: RouteFanout;
  retry?: RouteRetry;
  on?: Record<string, RouteTransitionDoc>;
  onFailure?: Record<string, RouteTransitionDoc>;
}

export interface RouteEscalationRecord {
  from: string;
  allowedRoutes: string[];
  requiresHumanWhenPinned: boolean;
}

export interface RouteMachineDoc {
  schema: number;
  kind: string;
  profile: string;
  id: string;
  title?: string;
  bootstrap?: 'required' | 'skip';
  entry: string;
  sequence: { bootstrap?: string[]; main?: string[]; tail?: string[] };
  nodes: RouteNodeDoc[];
  escalation: RouteEscalationRecord[];
}

export interface RouteCatalogDoc {
  schema: number;
  profile: string;
  routes: Record<string, string>;
  bootstrap: { file: string };
}

export interface DraftNode extends Omit<RouteNodeDoc, 'on' | 'onFailure'> {
  on?: Record<string, RouteTransitionDoc | null>;
  onFailure?: Record<string, RouteTransitionDoc | null>;
}

export interface DraftMachine extends Omit<RouteMachineDoc, 'entry' | 'nodes'> {
  entry: string | null;
  nodes: DraftNode[];
}
