import type { ReleaseIdentity } from '../../shared/runtime/installedUpdateContracts.ts';

declare const __GRIGDESK_BUILD_IDENTITY__: ReleaseIdentity | null;

// Identity запечатывает сборщик; runtime env и current.json не могут её подменить.
// Source-запуск без официального build input не объявляет identity готового выпуска.
export const desktopBuildIdentity = typeof __GRIGDESK_BUILD_IDENTITY__ === 'undefined'
  ? null : __GRIGDESK_BUILD_IDENTITY__;
