import type {
  AccessMethod, AccessProfile, AccessAttempt,
} from '../../../../shared/chat/accessProfileContracts.ts';
import type { DirectoryLockOwner } from '../../../../shared/node/directoryLock.ts';
import type { ExecutorAdapter } from '../executors/index.ts';

export interface AccessEvidence {
  kind: 'known' | 'unknown';
  account?: string;
}

export interface VerifiedAccess {
  env: NodeJS.ProcessEnv;
  evidence: AccessEvidence;
}

export interface AccessDriverContext {
  config: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  adapter: ExecutorAdapter;
  home: string;
  method: AccessMethod;
}

export interface AccessCapability {
  methods: AccessMethod[];
  envKeys: string[];
  homeKey?: string;
  runtimeEnvKeys?: string[];
  scopeConfig?: (config: AccessConfig, scope: string) => AccessConfig;
  runtimeConfig?: (config: AccessConfig, env: NodeJS.ProcessEnv) => AccessConfig;
  canResume?: (previous: NodeJS.ProcessEnv, next: VerifiedAccess) => Promise<boolean>;
  credentialFingerprint?: (env: NodeJS.ProcessEnv) => Promise<string | null>;
  cli?: {
    version: string;
    args: string[];
    protocol: 'codex-rpc' | 'manual-code' | 'device-code';
    hosts: string[];
    credentialFile: string;
  };
  bind?: (env: NodeJS.ProcessEnv, config: Record<string, unknown>,
    adapter: ExecutorAdapter) => Partial<ExecutorAdapter>;
  legacy: (env: NodeJS.ProcessEnv, config?: AccessConfig) => Array<{
    methodId: string;
    env: NodeJS.ProcessEnv;
    active: boolean;
  }>;
  verify?: (input: Record<string, unknown>, context: AccessDriverContext) => Promise<VerifiedAccess>;
}

export interface PrivateProfile extends AccessProfile {
  secretRef: string;
  evidence: AccessEvidence;
  memoryGeneration?: number;
}

export interface PrivateAttempt extends AccessAttempt {
  owner: string;
  ownerProcess?: DirectoryLockOwner;
  childProcess?: DirectoryLockOwner;
  loginStarting?: boolean;
  profileRevision?: number;
  candidate?: string;
  evidence?: AccessEvidence;
}

export interface AccessManifest {
  revision: number;
  activeProfileId: string | null;
  profiles: PrivateProfile[];
  attempts: PrivateAttempt[];
  operations: Record<string, {
    state: 'completed';
    attemptId?: string;
    profileId?: string;
  }>;
}

export interface AccessConfig {
  stateDir?: string;
  dataHome?: string;
  rootDir?: string;
  [key: string]: unknown;
}

export interface AccessOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  fault?: (point: string) => void;
}
