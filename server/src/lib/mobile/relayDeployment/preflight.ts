import { shellQuote } from '../../../../../shared/lib/shellQuote.ts';
import type { DeploymentJob } from '../../../../../shared/mobile/relayDeploymentContracts.ts';
import type { SshTransportSession } from '../../ssh/transport.ts';
import { command } from './sshClient.ts';

/**
 * Читает платформу и полномочия до передачи файлов или создания системных объектов.
 * Набор библиотек соответствует готовому Linux x64 ELF, а не локальному Node.
 */
export async function preflight(session: SshTransportSession, job: DeploymentJob): Promise<boolean> {
  const output = await command(session, `set -eu
. /etc/os-release
printf 'os=%s\\n' "$ID"
printf 'arch=%s\\n' "$(uname -m)"
printf 'glibc=%s\\n' "$(getconf GNU_LIBC_VERSION)"
test -d /run/systemd/system
systemctl --version >/dev/null
printf 'libs=%s\\n' "$(ldconfig -p | tr '\\n' ' ')"
if [ "$(id -u)" = 0 ]; then
  printf 'root=yes\\n'
else
  sudo -n true
  printf 'root=no\\n'
fi
printf 'busy=%s\\n' "$(ss -H -ltn 'sport = :${job.public.port}' | tr '\\n' ' ')"
for tool in sha256sum install mv cp mktemp flock; do
  command -v "$tool" >/dev/null
done`);
  const values = Object.fromEntries(output.trim().split('\n').map((line) => {
    const index = line.indexOf('=');

    return [line.slice(0, index), line.slice(index + 1)];
  }));
  const version = /^glibc (\d+)\.(\d+)$/.exec(values.glibc ?? '');
  const libraries = ['libdl.so.2', 'libstdc++.so.6', 'libm.so.6', 'libgcc_s.so.1',
    'libpthread.so.0', 'libc.so.6', 'ld-linux-x86-64.so.2'];

  if (!['ubuntu', 'debian'].includes(values.os ?? '') || values.arch !== 'x86_64'
    || !version || Number(version[1]) < 2
    || Number(version[1]) === 2 && Number(version[2]) < 28
    || libraries.some((library) => !values.libs?.includes(library))) {
    throw new Error('unsupported_platform');
  }

  const root = values.root === 'yes';

  if (job.relayId) {
    await command(session, `${root ? '' : 'sudo -n '}sh -c ${shellQuote(ownership(job))}`);
  } else if (values.busy) {
    throw new Error('relay_port_busy');
  }

  return root;
}

/**
 * Присваивать чужие каталоги, пользователя и unit запрещено даже при свободном порте.
 * Совпавшая собственная установка опознаётся по server pin и устойчивому relay id.
 */
export function ownership(job: DeploymentJob): string {
  const id = job.relayId!;

  return `set -eu
base=/opt/grigdesk-relay/${id}
conf=/etc/grigdesk-relay/${id}
state=/var/lib/grigdesk-relay/${id}
unit=/etc/systemd/system/grigdesk-relay-${id}.service
for item in /opt/grigdesk-relay /etc/grigdesk-relay /var/lib/grigdesk-relay \
  "$base" "$conf" "$state" "$unit"; do
  test ! -L "$item"
done
if [ -f "$state/owner" ]; then
  test "$(cat "$state/owner")" = '${job.expectedServerFp}:${id}'
else
  test ! -e "$base"
  test ! -e "$conf"
  test ! -e "$state"
  test ! -e "$unit"
  if getent passwd grigdesk-relay-${id} >/dev/null; then exit 1; fi
  if getent group grigdesk-relay-${id} >/dev/null; then exit 1; fi
  test -z "$(ss -H -ltn 'sport = :${job.public.port}')"
fi`;
}
