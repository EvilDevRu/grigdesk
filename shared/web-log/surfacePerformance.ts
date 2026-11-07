export const SURFACE_KINDS = ['route', 'tool', 'settings', 'dialog'] as const;
export const SURFACE_PHASES = ['start', 'pending', 'ready', 'error', 'cancelled', 'suspended'] as const;
export const SURFACE_ORIGINS = ['navigation', 'input', 'observed', 'surface'] as const;
export const SURFACE_TARGETS = [
  'board', 'pipeline', 'sandboxes', 'studio3d', 'browser', 'showcase', 'chats', 'diff',
  'documents', 'terminal', 'ssh', 'db', 'docker', 'routes', 'projects',
  'code', 'shelf', 'tools', 'ext', 'video', 'inbox', 'github', 'telegram', 'surface',
  'settings', 'dialog', 'task', 'document', 'other',
  'interface.behavior', 'interface.notifications', 'interface.shortcuts', 'interface.usageForecast',
  'agents.providers', 'agents.models', 'automation.chats', 'automation.context',
  'automation.launch', 'automation.monitoring', 'automation.arbiter', 'automation.analysis',
  'automation.shelf', 'automation.inbox', 'speech.dictation', 'speech.videoTasks',
  'connections.devices', 'connections.mobile', 'connections.ssh', 'connections.db', 'connections.telegram',
  'connections.github', 'tools.code', 'tools.docker', 'tools.studio3d', 'tools.showcase',
  'tools.browser', 'plugins.installed', 'system.startup', 'system.updates',
  'system.diagnostics', 'system.processes',
] as const;

export type SurfaceKind = typeof SURFACE_KINDS[number];
export type SurfacePhase = typeof SURFACE_PHASES[number];
export type SurfaceOrigin = typeof SURFACE_ORIGINS[number];

export interface SurfaceTiming {
  surface: number;
  kind: SurfaceKind;
  target: string;
  view: string;
  phase: SurfacePhase;
  origin: SurfaceOrigin;
  first: boolean;
  ms: number;
  mountedMs?: number;
  pending: number;
}

export interface ApiSummary {
  method: string;
  path: string;
  count: number;
  totalMs: number;
  maxMs: number;
  headersMs: number;
  bodyMs: number;
  parseMs: number;
  serverMs: number;
  serverCount: number;
  pipeMs: number;
  pipeCount: number;
  periodMs: number;
}

export const SHELL_OPERATIONS = ['detect', 'connect', 'disconnect', 'unlock', 'action'] as const;
