import { readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';

import { decodeDeploymentSnapshot, type DeploymentSnapshot as DeploymentJob }
  from '../shared/mobile/relayDeploymentContracts.ts';
import type { Settings } from '../shared/runtime/runtimeSettings.ts';
import type { CliArgs } from './args.ts';
import { cliTranslator } from './i18n.ts';
import { serverSession } from './serverSession.ts';
import { TerminalSession, terminalText } from './terminal.ts';
import { renderTerminalQr } from './terminalQr.ts';

class InputExit extends Error {
  readonly code: number;

  constructor(code: number) {
    super('input_closed');
    this.code = code;
  }
}

/**
 * Ввод читает raw-клавиши общей сессии, секрет не рисуется даже звёздочками.
 * Любое завершение проходит через finally TerminalSession и восстанавливает терминал.
 */
async function input(session: TerminalSession, label: string, secret = false): Promise<string> {
  session.output.write(label + ': ');

  let value = '';

  while (true) {
    const key = await session.nextKey();

    if (['interrupt', 'terminate', 'escape', 'eof'].includes(key.name) || key.text === '\x04') {
      throw new InputExit(key.name === 'interrupt' ? 130 : key.name === 'terminate' ? 143 : 2);
    }

    if (key.name === 'return') {
      session.output.write('\n');

      return value;
    }

    if (key.name === 'backspace') {
      // Backspace на пустом вводе не трогает выведенное приглашение.
      if (value.length) {
        value = [...value].slice(0, -1).join('');

        if (!secret) {
          session.output.write('\b \b');
        }
      }
    } else if (key.text && !/[\x00-\x1f\x7f]/u.test(key.text)) {
      value += key.text;

      if (!secret) {
        session.output.write(terminalText(key.text, session.columns));
      }
    }
  }
}

/**
 * Обе поставки консоли используют один HTTP-контракт и один мастер.
 * Закрытие клиента оставляет серверное задание жить; повтор сначала читает его снимок.
 */
export async function relaySetup(args: CliArgs, settings: Settings): Promise<number> {
  const { t } = cliTranslator();
  const label = (key: string) => t('remote.' + key);

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(label('tty') + '\n');

    return 2;
  }

  const terminal = new TerminalSession();

  return terminal.run(async () => {
    try {
      const cookie = await serverSession(settings);
      /**
       * Запрос ограничен выбранным локальным сервером и короткой сессией человека.
       * Сырые серверные ошибки и тело с секретом не попадают в терминал.
       */
      const request = async <T>(route: string, body?: unknown,
        binary = false, timeoutMs = 10000): Promise<T> => {
        const response = await fetch(settings.origin + route, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { cookie, 'content-type': binary ? 'application/octet-stream' : 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        });

        if (!response.ok) {
          await response.body?.cancel();

          throw new Error(label('requestFailed'));
        }

        return await response.json() as T;
      };
      const unwrap = (value: unknown) => decodeDeploymentSnapshot(value);
      const status = await request<{
        server: { fp: string; name?: string };
        relays: {
          id: string;
          name: string;
          host: string;
          port: number;
        }[];
      }>('/api/mobile/status');

      if (!status.server?.fp) {
        throw new Error(label('homeUnavailable'));
      }

      const listed = await request<{ jobs: DeploymentJob[] }>('/api/mobile/deployments');
      let job = listed.jobs.map(unwrap).find((item) => !['ready', 'failed'].includes(item.state));

      terminal.output.write(label('home') + ': ' + terminalText(status.server.name ?? settings.origin, 100)
        + '\n');

      if (!job) {
        let relay = status.relays[0];
        let name: string | undefined;

        if (args.action === 'restore') {
          if (!relay) {
            throw new Error(label('noRelay'));
          }

          terminal.output.write(status.relays.map((item, index) =>
            `${index + 1}. ${terminalText(item.name, 80)}`).join('\n') + '\n');

          const choice = await input(terminal, label('choose'));

          relay = status.relays[Number(choice || 1) - 1]!;

          if (!relay) {
            throw new InputExit(2);
          }
        } else {
          name = await input(terminal, label('name'));
        }

        const host = await input(terminal, label('host'));
        const user = await input(terminal, label('user'));

        // Публичный адрес по умолчанию берётся из SSH-хоста, и IPv6 туда не проходит.
        if (!args.publicHost && host.includes(':')) {
          throw new Error(label('publicRequired'));
        }

        const value = await request<DeploymentJob | { job: DeploymentJob }>('/api/mobile/deployments', {
          requestId: randomUUID(),
          expectedServerFp: status.server.fp,
          mode: args.action,
          ...(name === undefined ? { relayId: relay!.id } : { name }),
          ssh: {
            host,
            user,
            port: args.sshPort ?? 22,
          },
          public: { host: args.publicHost ?? (name === undefined ? relay!.host : host),
            port: args.publicPort ?? (name === undefined ? relay!.port : 443) },
          candidateHost: args.candidateHost ?? host,
        });

        job = unwrap(value);
      }

      const action = async (name: string, extra: Record<string, unknown> = {},
        binary = false, timeoutMs = 10000) => {
        job = unwrap(await request<DeploymentJob | { job: DeploymentJob }>(
          `/api/mobile/deployments/${encodeURIComponent(job!.id)}/${name}`,
          { revision: job!.revision, ...extra }, binary, timeoutMs));
      };

      while (true) {
        if (['draft', 'failed', 'interrupted', 'recovery_required'].includes(job.state)) {
          if (job.state !== 'draft') {
            const code = job.error?.code;

            terminal.output.write(label(code === 'ssh_auth_failed' ? 'authFailed'
              : code === 'unsupported_platform' ? 'platformFailed'
                : code === 'relay_port_busy' ? 'portBusy'
                  : code === 'waiting_vpn' ? 'waiting_vpn'
                    : code === 'route_conflict' ? 'routeConflict' : 'failedGeneric') + '\n');
            await input(terminal, label('retry'));
            await action('retry', { requestId: randomUUID() });
          }

          // SSH-probe на сервере держит соединение до 20 секунд: таймаут CLI больше серверного.
          await action('probe', {}, false, 25000);
        } else if (job.state === 'awaiting_host_key') {
          terminal.output.write(terminalText(job.hostKey?.fingerprint ?? '', 100) + '\n');

          if (job.hostKey?.decision === 'replace_required') {
            terminal.output.write(label('changedKey') + '\n');
          }

          const accepted = await input(terminal, label('trust'));

          if (!/^(да|yes|y)$/iu.test(accepted)) {
            await action('host-key', { challengeId: job.hostKey?.challengeId, decision: 'reject' });

            return 1;
          }

          await action('host-key', { challengeId: job.hostKey?.challengeId,
            decision: job.hostKey?.decision === 'replace_required' ? 'replace' : 'trust' });
        } else if (job.state === 'awaiting_credentials') {
          terminal.output.write(label('method') + '\n');

          let keySelected = false;

          while (true) {
            const key = await terminal.nextKey();

            if (key.name === 'down' || key.name === 'up') {
              keySelected = !keySelected;
            } else if (key.name === 'return') {
              break;
            } else if (key.name === 'interrupt') {
              throw new InputExit(130);
            } else if (key.text === '\x04' || ['eof', 'escape', 'terminate'].includes(key.name)) {
              throw new InputExit(2);
            } else {
              // Ввод пароля без выбора метода остаётся совместим с быстрым мастером.
              const first = key.text;
              const password = first + await input(terminal, label('password'), true);

              await action('credentials', { attemptId: randomUUID(), password }, true);
              break;
            }
          }

          if (job.state !== 'awaiting_credentials') {
            continue;
          }

          if (keySelected) {
            const file = await input(terminal, label('keyFile'));

            // Файл ключа ограничен тем же binary-контрактом, что и ввод через браузер.
            if ((await stat(file)).size > 60_000) {
              throw new Error(label('keyFile'));
            }

            let privateKey = await readFile(file, 'utf8');
            let passphrase = await input(terminal, label('passphrase'), true);

            await action('credentials', {
              attemptId: randomUUID(),
              privateKey,
              passphrase,
            }, true);
            privateKey = '';
            passphrase = '';
          } else {
            const password = await input(terminal, label('password'), true);

            await action('credentials', { attemptId: randomUUID(), password }, true);
          }
        } else if (job.state === 'awaiting_confirmation') {
          const changes: Record<string, string> = {
            install_relay_binary: label('changeBinary'),
            create_service_user: label('changeUser'),
            write_private_config: label('changeConfig'),
            enable_systemd: label('changeService'),
          };

          terminal.output.write((job.preview?.changes ?? [])
            .map((item) => terminalText(changes[item] ?? item, 100))
            .join('\n') + '\n');

          const accepted = await input(terminal, label('start'));

          if (!/^(да|yes|y)$/iu.test(accepted)) {
            return 2;
          }

          await action('start', { requestId: randomUUID(), previewDigest: job.preview?.digest });
        } else if (job.state === 'ready') {
          const qr = await request<{ text: string; qr: { rows: string[] } }>(
            '/api/devices/phone-pairing', { relayId: job.relayId });

          terminal.output.write(label('ready') + '\n' + renderTerminalQr(qr.qr.rows, false)
            + qr.text + '\n' + label(job.routeUpdateRequired ? 'routeUpdate' : 'phonePending') + '\n');
          await terminal.nextKey();

          return 0;
        } else if (['awaiting_dns', 'waiting_vpn'].includes(job.state)) {
          await input(terminal, label(job.state));
          await action('check', { requestId: randomUUID() });
        } else {
          terminal.output.write(label('working') + '\n');
          // Пауза закрывает осиротевшего читателя: Ctrl+C не теряется между опросами.
          await Promise.race([pause(250).then(() => terminal.cancelReader()),
            terminal.nextKey().then((key) => {
              if (['interrupt', 'terminate', 'escape', 'eof'].includes(key.name) || key.text === '\x04') {
                throw new InputExit(key.name === 'interrupt' ? 130 : 2);
              }
            })]);
          job = unwrap(await request<DeploymentJob | { job: DeploymentJob }>(
            `/api/mobile/deployments/${encodeURIComponent(job.id)}`));
        }
      }
    } catch (error) {
      if (error instanceof InputExit) {
        return error.code;
      }

      terminal.output.write(label('requestFailed') + '\n');

      return 1;
    }
  });
}
