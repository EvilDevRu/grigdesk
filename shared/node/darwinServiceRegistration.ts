import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { InstallationReceipt } from './installedLayout.ts';
import { canonicalDataPath } from './dataHomePlacement.ts';
import { sha256 } from './hash.ts';

export const DARWIN_SERVICE_MARKER = 'GRIGDESK_LAUNCH_AGENT';
export const DARWIN_SERVICE_ENV = [
  'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'TMPDIR',
  'GRIGDESK_HOME', 'PATH', 'LANG', DARWIN_SERVICE_MARKER,
] as const;

export interface DarwinServiceReceipt {
  format: 1;
  installationId: string;
  uid: number;
  plist: string;
  label: string;
  sha256: string;
}

const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

/**
 * Стабильный LaunchAgent начинает с env -i и запускает literal argv.
 * Его stdout и stderr принадлежат программе этой установки.
 */
export function darwinServiceRegistration(
  receipt: InstallationReceipt, unitDirectory: string, env = process.env,
) {
  const label = 'com.grigdesk.server.' + receipt.installationId;
  const plist = path.join(unitDirectory, label + '.plist');
  const log = path.join(receipt.root, 'update/server.log');
  const home = canonicalDataPath(os.homedir(), fs);
  const values: Record<(typeof DARWIN_SERVICE_ENV)[number], string> = {
    HOME: home,
    XDG_CONFIG_HOME: canonicalDataPath(env.XDG_CONFIG_HOME || path.join(home, '.config'), fs),
    XDG_DATA_HOME: canonicalDataPath(env.XDG_DATA_HOME || path.join(home, '.local/share'), fs),
    XDG_CACHE_HOME: canonicalDataPath(env.XDG_CACHE_HOME || path.join(home, '.cache'), fs),
    TMPDIR: canonicalDataPath(os.tmpdir(), fs),
    GRIGDESK_HOME: receipt.dataHome,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
    GRIGDESK_LAUNCH_AGENT: label,
  };
  const assignments = DARWIN_SERVICE_ENV.map((name) => `${name}=${values[name]}`);
  const launcher = path.join(receipt.root, 'bin/grigdesk-server');
  const argv = ['/usr/bin/env', '-i', ...assignments, '/bin/sh', launcher];

  if (Object.entries(values).some(([name, value]) => /[\x00-\x1f\x7f]/u.test(value)
    || (name.startsWith('XDG_') || ['HOME', 'TMPDIR', 'GRIGDESK_HOME'].includes(name))
      && (!path.isAbsolute(value) || path.resolve(value) !== value))) {
    throw new Error('installation_service_environment_invalid');
  }

  const program = argv.map((arg) => `<string>${xml(arg)}</string>`).join('');
  const bytes = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
    + '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + '<plist version="1.0"><dict>\n'
    + `<key>Label</key><string>${xml(label)}</string>\n`
    + `<key>ProgramArguments</key><array>${program}</array>\n`
    + `<key>WorkingDirectory</key><string>${xml(receipt.root)}</string>\n`
    + `<key>StandardOutPath</key><string>${xml(log)}</string>\n`
    + `<key>StandardErrorPath</key><string>${xml(log)}</string>\n`
    + '<key>RunAtLoad</key><false/>\n'
    + '<key>KeepAlive</key><false/>\n'
    + '<key>ExitTimeOut</key><integer>60</integer>\n'
    + '</dict></plist>\n';
  const service: DarwinServiceReceipt = {
    format: 1,
    installationId: receipt.installationId,
    uid: receipt.uid,
    plist,
    label,
    sha256: sha256(bytes),
  };

  return { service, bytes };
}
