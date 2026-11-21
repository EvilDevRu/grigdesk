import path from 'node:path';

import { verifyWindowsNative, windowsStableInputs } from './windowsNative.mts';

const [target, planFile, source, output, ...extra] = process.argv.slice(2);

if (!source || !output || extra.length) {
  throw new Error('stable_native_verify_arguments_invalid');
}

const input = await windowsStableInputs(target, planFile);

await verifyWindowsNative(input.target, input.plan, input.planDigest, path.resolve(source), path.resolve(output));
