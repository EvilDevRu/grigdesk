import type { Component, DeepReadonly, Ref } from 'vue';
import type { ChatWorkdir } from '../../../shared/chat/chatWorkdir.js';
import type { MessageParams, UiText } from '../../../shared/i18n/core.js';
import type { UiToastTone } from '../../../web/src/ui.js';

export interface PluginRequestOptions {
  timeoutMs?: number;
  idleTimeoutMs?: number;
  retry?: boolean;
  signal?: AbortSignal;
}

export interface PluginApi {
  get(path: string, options?: PluginRequestOptions): Promise<unknown>;
  post(path: string, body?: unknown, options?: PluginRequestOptions): Promise<unknown>;
  put(path: string, body?: unknown): Promise<unknown>;
  patch(path: string, body?: unknown): Promise<unknown>;
  del(path: string, body?: unknown): Promise<unknown>;
}

export interface PluginBaseContext {
  pluginId: string;
  api: PluginApi;
  locale: Readonly<Ref<string>>;
  settings: DeepReadonly<Ref<Record<string, unknown>>>;
  t(key: string, params?: MessageParams, fallback?: string): string;
}

export interface PluginEventOptions {
  lifetime?: 'panel' | 'background';
}

export interface PluginEvents {
  on(event: string, listener: (data: unknown) => void, options?: PluginEventOptions): () => void;
}

export interface PluginAlertInput {
  id: string;
  title: UiText;
  body?: UiText;
  detail?: UiText;
  tone?: UiToastTone;
  sticky?: boolean;
  openPanel?: boolean;
}

export interface PluginAlerts {
  show(input: PluginAlertInput): boolean;
  dismiss(id: string): void;
  clear(): void;
}

export interface PluginAskAgentInput {
  workdir: ChatWorkdir;
  title: string;
  draft: string;
}

export interface PluginPanel {
  open(): Promise<boolean>;
  close(): Promise<boolean>;
  setExpanded(value: boolean): boolean;
}

export interface PluginModuleContext extends PluginBaseContext {
  signal: AbortSignal;
  events: PluginEvents;
  alerts: PluginAlerts;
  askAgent(input: PluginAskAgentInput): Promise<string>;
  panel: PluginPanel;
}

export type PluginPresentation = 'page' | 'dock' | 'hidden' | 'placeholder';

export interface PluginPanelProps {
  context: PluginModuleContext;
  active?: boolean;
  compact?: boolean;
  presentation?: PluginPresentation;
}

export type PluginModuleCleanup = () => void;
export type PluginModuleStart = (context: PluginModuleContext) =>
  void | PluginModuleCleanup | Promise<void | PluginModuleCleanup>;

export interface PluginUiModule {
  default: Component;
  start?: PluginModuleStart;
}
