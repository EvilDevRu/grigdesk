import path from 'node:path';

import { unixStableInputs, verifyUnixNative } from './linuxNative.mts';
import { verifyWindowsNative, windowsStableInputs } from './windowsNative.mts';

const [target, planFile, source, output, ...extra] = process.argv.slice(2);

if (!source || !output || extra.length) {
  throw new Error('stable_native_verify_arguments_invalid');
}

if (target === 'windows-x64' || target === 'windows-arm64') {
  const input = await windowsStableInputs(target, planFile);

  await verifyWindowsNative(
    input.target, input.plan, input.planDigest, path.resolve(source), path.resolve(output),
  );
} else if (target === 'linux-arm64' || target === 'darwin-arm64') {
  const input = await unixStableInputs(target, planFile);

  await verifyUnixNative(
    input.target, input.plan, input.planDigest, path.resolve(source), path.resolve(output),
  );
} else {
  throw new Error(`stable_native_adapter_missing (${target})`);
}