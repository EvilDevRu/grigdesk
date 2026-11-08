import type { SshTransportSession } from '../../ssh/transport.ts';

/**
 * Ограничивает срок и объём команды, не передавая наружу stderr удалённой машины.
 * Закрытие SSH прерывает ожидание даже без exit-status от удалённого процесса.
 */
export async function command(session: SshTransportSession, script: string): Promise<string> {
  const channel = await session.exec(script);

  return new Promise((resolve, reject) => {
    let output = '';
    let finished = false;
    const timer = setTimeout(() => finish(new Error('ssh_command_timeout')), 30_000);

    /**
     * Завершает ожидание ровно один раз и снимает listener SSH-соединения.
     * Ошибка закрывает канал, не публикуя удалённый вывод в исключении.
     */
    const finish = (error: Error | null, code = 0) => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timer);
      session.client.off('close', disconnected);

      if (error || code !== 0) {
        channel.destroy();
        reject(error ?? new Error('remote_command_failed'));
      } else {
        resolve(output);
      }
    };
    const disconnected = () => finish(new Error('ssh_disconnected'));

    session.client.once('close', disconnected);
    channel.on('data', (bytes: Buffer) => {
      output += bytes.toString('utf8');

      if (output.length > 65_536) {
        finish(new Error('ssh_output_limit'));
      }
    });
    channel.stderr?.on('data', () => {});
    channel.once('error', () => finish(new Error('ssh_disconnected')));
    channel.once('close', (code: number) => finish(null, code ?? 1));
  });
}

/**
 * Ждёт подтверждения записи и закрытия файла SFTP без локального дочернего процесса.
 * Файл создаётся исключительно внутри приватного staging с правами 0600.
 */
export async function upload(session: SshTransportSession, target: string, bytes: Buffer): Promise<void> {
  const sftp = await session.sftp();

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('ssh_upload_timeout'));
        sftp.end?.();
      }, 60_000);

      sftp.once('close', () => {
        clearTimeout(timer);
        reject(new Error('ssh_upload_failed'));
      });
      sftp.once('error', () => {
        clearTimeout(timer);
        reject(new Error('ssh_upload_failed'));
      });
      sftp.writeFile(target, bytes, { mode: 0o600, flag: 'wx' }, (error) => {
        clearTimeout(timer);

        if (error) {
          reject(new Error('ssh_upload_failed'));
        } else {
          resolve();
        }
      });
    });
  } finally {
    sftp.end?.();
  }
}
