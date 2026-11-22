import path from 'node:path';

import { buildWindowsNative, productionWindowsKey, windowsStableInputs } from './windowsNative.mts';

const [target, planFile, output, ...extra] = process.argv.slice(2);

if (!output || extra.length) {
  throw new Error('stable_native_build_arguments_invalid');
}

const input = await windowsStableInputs(target, planFile);

await buildWindowsNative(input.target, input.plan, path.resolve(output), productionWindowsKey());
