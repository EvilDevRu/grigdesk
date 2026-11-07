import type { Buffer } from 'node:buffer';
import type { FastifyInstance } from 'fastify';
import type { PluginMetadata } from './manifest.ts';
import type { PluginProvider } from './provider.ts';
import type { PluginRuntimeServices } from './coreRuntime.ts';
import type { ResolvedDocument } from '../../../shared/plugins/documents/documentsContracts.ts';
import type { PluginNotification } from '../../../shared/plugins/pluginNotifications.ts';

export type { PluginNotification } from '../../../shared/plugins/pluginNotifications.ts';

export type * from './provider.ts';
export type * from './coreRuntime.ts';

export type AuthKind = 'session' | 'internal' | 'cli' | null;

declare module 'fastify' {
  interface FastifyRequest {
    authKind?: AuthKind;
  }
}

export interface PluginChange {
  enabled?: boolean;
  values?: Record<string, unknown>;
}

export interface PluginTransition {
  commit(): void;
  rollback(): Promise<void>;
  afterCommit(): Promise<void>;
}

export interface ReplacementLease {
  finish(outcome: 'installed' | 'reverted' | 'blocked'): Promise<void>;
}

export interface PluginLifecycle {
  busyReason: null | (() => unknown);
  prepareReplace: null | ((signal: AbortSignal) => Promise<ReplacementLease>);
  onEnable?: () => unknown;
  onDisable?: () => unknown;
  notifications?: (signal: AbortSignal) => Promise<PluginNotification[]>;
  prepareChange?: (change: PluginChange, signal: AbortSignal) =>
    PluginTransition | undefined | Promise<PluginTransition | undefined>;
}

export interface PluginFileLockOptions {
  lockPath: string;
  mode?: 'exclusive' | 'shared';
  timeoutMs?: number;
  timeoutCode?: string;
  unavailableCode?: string;
  lostCode?: string;
  label?: string;
}

export interface PluginFileLock {
  assertHeld(): void;
  assertPathIdentity(): Promise<void>;
  assertPathIdentityNow(): void;
  release(): Promise<void>;
}

export interface PluginDocumentRef {
  source?: unknown;
  path?: unknown;
}

export interface PluginDocumentRoot {
  id: string;
  label: string;
  path: string;
}

export interface PluginDocument extends ResolvedDocument {
  displayPath: string;
  size: number;
  modifiedAt: string;
  content: string;
}

export interface PluginDocumentAsset {
  content: Buffer;
  contentType: string;
  size: number;
  modifiedAt: string;
}

export interface PluginDocuments {
  roots(scope?: unknown): Promise<PluginDocumentRoot[]>;
  resolveAbsolute(inputPath: unknown, scope?: unknown): Promise<ResolvedDocument>;
  read(ref: PluginDocumentRef | null | undefined): Promise<PluginDocument>;
  readAsset(ref: PluginDocumentRef | null | undefined): Promise<PluginDocumentAsset>;
}

export interface PluginCore extends Partial<PluginRuntimeServices> {
  getProviders(type: unknown): Promise<PluginProvider[]>;
  emit(event: string, data?: unknown): void;
  withPathLock<Result>(key: string, task: () => Promise<Result>): Promise<Result>;
  acquireKernelFileLock(options: PluginFileLockOptions): Promise<PluginFileLock>;
  parseByteRange(header: unknown, size: number): { start: number; end: number } | 'invalid' | null;
  documents: Readonly<PluginDocuments>;
}

export interface PluginServerOptions {
  config: { userPluginsDir: string; userPluginsDataDir?: string };
  prefs: {
    read(): Record<string, unknown>;
    write(patch?: Record<string, unknown> | null): Record<string, unknown>;
  };
  plugin: PluginMetadata;
  prefix: string;
  dataDir?: string;
  lifecycle: PluginLifecycle;
  core: PluginCore;
}

export type PluginServerAsync = (app: FastifyInstance, options: PluginServerOptions) => Promise<void>;
export type PluginServerCallback = (
  app: FastifyInstance,
  options: PluginServerOptions,
  done: (error?: Error) => void,
) => void;

export interface PluginServerModule {
  default: PluginServerAsync | PluginServerCallback;
}
