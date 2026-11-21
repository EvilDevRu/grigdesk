import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeWslProbe, resolveWindowsSpikeVerdicts } from '../../tools/windows/spike.mts';

const baseReport = () => ({
  format: 1,
  runner: 'windows-2025',
  windowsBuild: '10.0.26100',
  arch: 'x86_64',
  wsl2Available: true,
  bootId: '3f2b8c1e-9d4a-4b7e-8c2f-1a5d9e0b6c34',
  uid: 1000,
  flockOk: true,
  usernsOk: true,
  bwrapOk: true,
  seaOk: true,
  conptyOk: true,
  drvfsLock: {
    holderReady: true,
    contenderExit: 73,
    reacquiredExit: 0,
  },
  ext4Lock: {
    holderReady: true,
    contenderExit: 73,
    reacquiredExit: 0,
  },
});

test('WINDOWS-BRIDGE: decoder принимает полный отчёт WSL-пробы', () => {
  const report = decodeWslProbe(baseReport());

  assert.equal(report.bootId, '3f2b8c1e-9d4a-4b7e-8c2f-1a5d9e0b6c34');
  assert.equal(report.arch, 'x86_64');
  assert.equal(report.flockOk, true);
  assert.equal(report.usernsOk, true);
});

test('WINDOWS-BRIDGE: вердикты при исправном drvfs и userns', () => {
  const verdicts = resolveWindowsSpikeVerdicts(decodeWslProbe(baseReport()));

  assert.equal(verdicts.wsl2, true);
  assert.equal(verdicts.stateVolume, 'drvfs');
  assert.equal(verdicts.contained, true);
  assert.equal(verdicts.conpty, true);
  assert.equal(verdicts.sea, true);
});

test('WINDOWS-BRIDGE: boot_id не UUID отвергается', () => {
  const raw = baseReport();

  raw.bootId = 'not-a-uuid';
  assert.throws(() => decodeWslProbe(raw), /windows_probe_invalid/u);
});

test('WINDOWS-BRIDGE: чужая arch отвергается', () => {
  const raw = baseReport();

  raw.arch = 'riscv64';
  assert.throws(() => decodeWslProbe(raw), /windows_probe_invalid/u);
});

test('WINDOWS-BRIDGE: root-uid пробы отвергается', () => {
  const raw = baseReport();

  raw.uid = 0;
  assert.throws(() => decodeWslProbe(raw), /windows_probe_invalid/u);
});

test('WINDOWS-BRIDGE: отсутствие явного конфликта на drvfs исключает drvfs', () => {
  const raw = baseReport();

  raw.drvfsLock.contenderExit = 0;

  const verdicts = resolveWindowsSpikeVerdicts(decodeWslProbe(raw));

  assert.equal(verdicts.stateVolume, 'ext4');
});

test('WINDOWS-BRIDGE: holder не READY исключает drvfs', () => {
  const raw = baseReport();

  raw.drvfsLock.holderReady = false;

  const verdicts = resolveWindowsSpikeVerdicts(decodeWslProbe(raw));

  assert.equal(verdicts.stateVolume, 'ext4');
});

test('WINDOWS-BRIDGE: сломанный ext4-контроль останавливает мост', () => {
  const raw = baseReport();

  raw.ext4Lock.reacquiredExit = 1;
  assert.throws(() => resolveWindowsSpikeVerdicts(decodeWslProbe(raw)), /windows_bridge_ext4_invalid/u);
});

test('WINDOWS-BRIDGE: отказ базового flock останавливает мост', () => {
  const raw = baseReport();

  raw.flockOk = false;
  assert.throws(() => resolveWindowsSpikeVerdicts(decodeWslProbe(raw)), /windows_bridge_flock_invalid/u);
});

test('WINDOWS-BRIDGE: отказ userns даёт явный отказ contained', () => {
  const raw = baseReport();

  raw.usernsOk = false;

  const verdicts = resolveWindowsSpikeVerdicts(decodeWslProbe(raw));

  assert.equal(verdicts.contained, false);
});

test('WINDOWS-BRIDGE: лишний ключ отчёта отвергается', () => {
  const raw = { ...baseReport(), extra: true };

  assert.throws(() => decodeWslProbe(raw), /windows_probe_invalid/u);
});