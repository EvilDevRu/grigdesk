import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Определяет пути пакета от расположения модуля, независимо от cwd.
 * Общий источник путей используется подготовкой, сборкой и тестовым helper.
 */
export function deepSeekPackagePaths(): {
  root: string;
  vendorDir: string;
  runtimeDependenciesDir: string;
  dynamicImportsFile: string;
  licensesDir: string;
  hostFiles: Record<
    'entry' | 'webHost' | 'presetsHost' | 'acpSettingsBridge'
    | 'toolPermissionGate' | 'toolPermissionPolicy' | 'toolPermissionPaths', string
  >;
  scripts: Record<'composition' | 'inputs' | 'licenses' | 'vendor' | 'sync' | 'runtime', string>;
} {
  const root = fileURLToPath(new URL('..', import.meta.url));

  return {
    root,
    vendorDir: path.join(root, 'vendor/deepseek-harness'),
    runtimeDependenciesDir: path.join(root, 'build/runtime-deps'),
    dynamicImportsFile: path.join(root, 'build/dynamic-imports.json'),
    licensesDir: path.join(root, 'build/licenses'),
    hostFiles: {
      entry: path.join(root, 'src/host/entry.mjs'),
      webHost: path.join(root, 'src/host/webHost.mjs'),
      presetsHost: path.join(root, 'src/host/presetsHost.mjs'),
      acpSettingsBridge: path.join(root, 'src/host/acpSettingsBridge.mjs'),
      toolPermissionGate: path.join(root, 'src/host/toolPermissionGate.mjs'),
      toolPermissionPolicy: path.join(root, 'src/host/toolPermissionPolicy.mjs'),
      toolPermissionPaths: path.join(root, 'src/host/toolPermissionPaths.mjs'),
    },
    scripts: {
      composition: path.join(root, 'scripts/runtimeComposition.ts'),
      inputs: path.join(root, 'scripts/deepseekBuildInputs.ts'),
      licenses: path.join(root, 'scripts/deepseekBuildLicenses.ts'),
      vendor: path.join(root, 'scripts/deepseekVendorManifest.ts'),
      sync: path.join(root, 'scripts/syncDeepSeekHarness.mts'),
      runtime: path.join(root, 'scripts/buildRuntime.mts'),
    },
  };
}

