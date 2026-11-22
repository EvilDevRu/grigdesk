import assert from 'node:assert/strict';
import test from 'node:test';

import { unixStableInputs } from '../../tools/ci/linuxNative.mts';
import { windowsStableInputs } from '../../tools/ci/windowsNative.mts';

test('STABLE-ADAPTER: неизвестная цель не получает адаптер', async () => {
  await assert.rejects(unixStableInputs('windows-x64', 'plan.json'),
    /stable_native_adapter_missing/u);
  await assert.rejects(unixStableInputs('android', 'plan.json'),
    /stable_native_adapter_missing/u);
  await assert.rejects(windowsStableInputs('linux-arm64', 'plan.json'),
    /stable_native_adapter_missing/u);
  await assert.rejects(windowsStableInputs(undefined, 'plan.json'),
    /stable_native_adapter_missing/u);
});

test('STABLE-ADAPTER: цель проверяется на нативном раннере своей архитектуры', async () => {
  // Тест исполняется на Linux x64: ни ARM64, ни Windows не совпадают с хостом.
  await assert.rejects(unixStableInputs('linux-arm64', 'plan.json'),
    /unix_native_runner_mismatch/u);
  await assert.rejects(unixStableInputs('darwin-arm64', 'plan.json'),
    /unix_native_runner_mismatch/u);
  await assert.rejects(windowsStableInputs('windows-x64', 'plan.json'),
    /windows_native_runner_mismatch/u);
});