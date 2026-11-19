import assert from 'node:assert/strict';
import test from 'node:test';
import { darwinServiceRegistration } from '../../shared/node/darwinServiceRegistration.ts';
import { parseDarwinLoadedService } from '../../shared/node/launchdInstalledService.ts';
import type { InstallationReceipt } from '../../shared/node/installedLayout.ts';

test('MAC-LAUNCHD: argv с пробелом и знаком равенства проверяется целиком', () => {
  const receipt: InstallationReceipt = {
    format: 1,
    installationId: '93ac5ade-9184-48e8-853d-4d23fc389720',
    uid: process.getuid!(),
    root: '/program= fixture',
    mode: 'local',
    channel: 'dev',
    dataHome: '/test/data',
    userData: '/test/profile',
  };
  const { service, bytes } = darwinServiceRegistration(receipt, '/test/My Agents');
  const domain = 'gui/' + receipt.uid;
  const target = domain + '/' + service.label;
  const argv = ['/usr/bin/env', '-i', 'HOME=/test home',
    'GRIGDESK_HOME=/test/data', '/bin/sh', '/program= fixture/bin/grigdesk-server'];
  const registration = {
    receipt: service,
    argv,
    env: {},
    domain,
    target,
  };
  const listing = [
    target + ' = {',
    '\tpath = ' + service.plist,
    '\tstate = running',
    '\tprogram = /usr/bin/env',
    '\targuments = {',
    ...argv.map((arg) => '\t\t' + arg),
    '\t}',
    '\tpid = 9402',
    '}',
  ].join('\n');

  assert.match(bytes, /<key>RunAtLoad<\/key><false\/>/u);
  assert.match(bytes, /<string>\/bin\/sh<\/string><string>\/program= fixture\/bin\/grigdesk-server/u);
  assert.deepEqual(parseDarwinLoadedService(listing, registration), { pid: 9402, startScheduled: false });

  const withoutPid = listing.replace('\tpid = 9402\n', '');

  assert.deepEqual(parseDarwinLoadedService(withoutPid.replace('running', 'not running'), registration),
    { pid: null, startScheduled: false });
  assert.deepEqual(parseDarwinLoadedService(withoutPid.replace('running', 'spawn scheduled'), registration),
    { pid: null, startScheduled: true });
  assert.throws(() => parseDarwinLoadedService(listing.replace('\t\t-i\n', ''), registration),
    /release_foreign_service/u);
  assert.throws(() => parseDarwinLoadedService(listing.replace('HOME=/test home', 'HOME=/unrelated'),
    registration), /release_foreign_service/u);
});
