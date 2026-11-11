import type { EventEmitter } from 'node:events';
import type { ClientChannel, SFTPWrapper } from 'ssh2';

import type { SshTransportSession } from '../../ssh/transport.ts';

export class RemoteCommandError extends Error {
  readonly exitCode: number;

  constructor(exitCode: number) {
    super('remote_command_failed');
    this.exitCode = exitCode;
  }
}

interface ChannelOperation<Channel extends EventEmitter, Result> {
  open: () => Promise<Channel>;
  close: (channel: Channel) => void;
  run: (channel: Channel, finish: (error: Error | null, result?: Result) => void) => void;
  timeoutMs: number;
  timeoutCode: string;
  failureCode: string;
}

/**
 * Общий срок включает открытие SSH-канала: сервер может не подтвердить exec или SFTP вообще.
 * Поздно открывшийся канал закрывается, а таймаут уничтожает только соединение этой операции.
 */
function channelOperation<Channel extends EventEmitter, Result>(
  session: SshTransportSession,
  options: ChannelOperation<Channel, Result>,
): Promise<Result> {
  return new Promise((resolve, reject) => {
    let channel: Channel | undefined;
    let finished = false;
    const timer = setTimeout(() => {
      finish(new Error(options.timeoutCode));
      session.destroy();
    }, options.timeoutMs);

    /**
     * Срок, закрытие SSH и результат канала соревнуются за одно завершение.
     * Снятие listener предшествует закрытию канала, чтобы оно не подменяло исходную ошибку.
     */
    const finish = (error: Error | null, result?: Result) => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timer);
      session.client.off('close', disconnected);

      if (channel) {
        options.close(channel);
      }

      if (error) {
        reject(error);
      } else {
        resolve(result as Result);
      }
    };
    const disconnected = () => finish(new Error(options.failureCode));

    session.client.once('close', disconnected);
    void Promise.resolve().then(options.open).then((opened) => {
      if (finished) {
        // Канал не публикуется потребителю после таймаута; его поздняя ошибка также поглощается.
        opened.on('error', () => {});
        options.close(opened);

        return;
      }

      channel = opened;

      try {
        options.run(opened, finish);
      } catch {
        finish(new Error(options.failureCode));
      }
    }, () => finish(new Error(options.failureCode)));
  });
}

/**
 * Ограничивает срок и объём команды, не передавая наружу stderr удалённой машины.
 * Закрытие SSH прерывает ожидание даже без exit-status от удалённого процесса.
 */
export async function command(
  session: SshTransportSession,
  script: string,
  timeoutMs = 30_000,
): Promise<string> {
  return channelOperation<ClientChannel, string>(session, {
    open: () => session.exec(script),
    close: (channel) => channel.destroy(),
    timeoutMs,
    timeoutCode: 'ssh_command_timeout',
    failureCode: 'ssh_disconnected',
    run: (channel, finish) => {
      let output = '';

      channel.on('data', (bytes: Buffer) => {
        output += bytes.toString('utf8');

        if (output.length > 65_536) {
          finish(new Error('ssh_output_limit'));
        }
      });
      channel.stderr?.on('data', () => {});
      channel.once('error', () => finish(new Error('ssh_disconnected')));
      channel.once('close', (code: number) => finish(code === 0 ? null : new RemoteCommandError(code ?? 1),
        output));
    },
  });
}

/**
 * Ждёт подтверждения записи и закрытия файла SFTP без локального дочернего процесса.
 * Файл создаётся исключительно внутри приватного staging с правами 0600.
 */
export async function upload(
  session: SshTransportSession,
  target: string,
  bytes: Buffer,
  timeoutMs = 60_000,
): Promise<void> {
  return channelOperation<SFTPWrapper, void>(session, {
    open: () => session.sftp(),
    close: (sftp) => sftp.end?.(),
    timeoutMs,
    timeoutCode: 'ssh_upload_timeout',
    failureCode: 'ssh_upload_failed',
    run: (sftp, finish) => {
      sftp.once('close', () => finish(new Error('ssh_upload_failed')));
      sftp.once('error', () => finish(new Error('ssh_upload_failed')));
      sftp.writeFile(target, bytes, { mode: 0o600, flag: 'wx' }, (error) => {
        finish(error ? new Error('ssh_upload_failed') : null);
      });
    },
  });
}
