import type { DeepSeekRuntimeInfo } from '../../shared/chat/deepSeekBinary.ts';
import { GLM_PROFILE_REVISION, GLM_POLICY_REVISION } from '../../server/src/lib/glm/contract.ts';

/**
 * Описание не привязано к текущей upstream-версии и ABI сервера.
 * Синтетические отпечатки имеют настоящий формат SHA256, но не дают допуска GLM.
 */
export function runtimeInfoFixture(options: { toolPermissions?: boolean } = {}): DeepSeekRuntimeInfo {
  return {
    format: 1,
    binaryVersion: '0.1.0',
    upstreamVersion: '9.2.0-compatible',
    packageId: 'a'.repeat(64),
    buildId: 'b'.repeat(64),
    runtimeVersion: '9.2.0.grigdesk.bbbbbbbbbbbbbbbbb',
    hostContract: 1,
    journal: {
      write: 2,
      read: [1, 2],
    },
    platform: 'linux',
    arch: 'x64',
    workerNode: {
      version: '24.21.0',
      abi: '137',
      sha256: 'c'.repeat(64),
    },
    capabilities: {
      web: true,
      acp: true,
      settingsWeb: true,
      settingsAcp: true,
      glmNativeGate: true,
      ...(options.toolPermissions === undefined ? {} : { toolPermissions: options.toolPermissions }),
    },
    glm: {
      inputs: {
        source: { commit: 'c291e7961a515f6d7af9304e7fd1d257929aef26' },
        inputIdentity: {
          composition: 'grigdesk-host-web-acp-v3',
          dependencyLock: 'd'.repeat(64),
        },
        llmPiAi: {
          piAi: {
            version: '0.85.1',
            integrity: 'sha512-synthetic',
          },
          sourceHash: 'e'.repeat(64),
          patches: [{ path: 'host.patch', sha256: 'f'.repeat(64) }],
        },
      },
      profileRevision: GLM_PROFILE_REVISION,
      policyRevision: GLM_POLICY_REVISION,
      admission: [{ mode: 'api', compatibility: '1'.repeat(64) }],
    },
  };
}

