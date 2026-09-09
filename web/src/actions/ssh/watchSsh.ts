import { sseSubscribe } from '../../composables/useSse.js';
import { useSshStore } from '../../stores/ssh.ts';
import { loadSsh, reloadSshAudit } from './loadSsh.ts';
import { runtimeOf } from './sshRuntime.ts';

/**
 * Подписка на события раздела заводится один раз. Сессии открывает и закрывает сервер,
 * в том числе по просьбе другого окна, поэтому список живёт событиями, а не опросом;
 * запись в журнале приходит отдельным событием и не требует перечитывать весь раздел.
 */
export function watchSsh(): void {
  const runtime = runtimeOf(useSshStore());

  if (runtime.off) {
    return;
  }

  runtime.off = sseSubscribe((name: string) => {
    if (name === 'ssh-sessions') {
      void loadSsh();
    }

    if (name === 'ssh-audit') {
      void reloadSshAudit();
    }
  });
}
