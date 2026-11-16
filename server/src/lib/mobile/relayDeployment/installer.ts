import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { shellQuote } from '../../../../../shared/lib/shellQuote.ts';
import type { DeploymentJob } from '../../../../../shared/mobile/relayDeploymentContracts.ts';
import { sha256File } from '../../../../../shared/node/hash.ts';
import type { SshTransportSession } from '../../ssh/transport.ts';
import type { RelayArtifact } from './artifact.ts';
import { ownership, preflight } from './preflight.ts';
import { command, upload } from './sshClient.ts';

export interface RelayInstallation {
  replaced: boolean;
  wasRunning: boolean;
  rollback: () => Promise<void>;
  dispose: () => Promise<void>;
}

/**
 * Формирует службу без прав root и с единственной capability для привилегированного порта.
 * systemd читает защищённый EnvironmentFile до перехода к отдельному пользователю.
 */
function serviceUnit(job: DeploymentJob): string {
  const name = `grigdesk-relay-${job.relayId}`;
  const capability = job.public.port < 1024 ? 'CAP_NET_BIND_SERVICE' : '';

  return `[Unit]
Description=GrigDesk relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${name}
Group=${name}
EnvironmentFile=/etc/grigdesk-relay/${job.relayId}/relay.env
ExecStart=/opt/grigdesk-relay/${job.relayId}/grigdesk-relay
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
RestrictSUIDSGID=true
CapabilityBoundingSet=${capability}
AmbientCapabilities=${capability}

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Повторяет проверки перед upload и держит удалённый lock при публикации поколения.
 * При сбое откатывает только собственные файлы; неизвестный результат требует recovery.
 */
export async function installRelay(
  session: SshTransportSession,
  job: DeploymentJob,
  artifact: RelayArtifact,
  env: string,
): Promise<RelayInstallation> {
  if (await sha256File(artifact.file) !== artifact.digest) {
    throw new Error('relay_artifact_corrupt');
  }

  const root = await preflight(session, job);
  const staging = `/tmp/grigdesk-relay-${randomUUID()}`;
  const quoted = shellQuote(staging);
  const privileged = (script: string) => `${root ? '' : 'sudo -n '}sh -c ${shellQuote(script)}`;
  const dispose = async () => {
    await command(session, privileged(`rm -rf -- ${quoted}`)).catch(() => {});
  };

  await command(session, `umask 077; mkdir ${quoted}`);

  try {
    await upload(session, `${staging}/binary`, await readFile(artifact.file));
    await upload(session, `${staging}/relay.env`, Buffer.from(`RELAY_PORT=${job.public.port}\n${env}`));
    await upload(session, `${staging}/unit`, Buffer.from(serviceUnit(job)));
    await command(session, `set -eu
chmod 755 ${quoted}/binary
printf '%s  %s\\n' '${artifact.digest}' ${quoted}/binary | sha256sum -c - >/dev/null
${quoted}/binary --version >/dev/null`);

    const result = await command(session, privileged(installScript(job, staging)));

    return {
      replaced: result.includes('previous=yes'),
      wasRunning: result.includes('active=yes'),
      rollback: async () => {
        await command(session, privileged(rollbackScript(job, staging)));
      },
      dispose,
    };
  } catch (error) {
    const retained = await command(session, privileged(`set -eu
if [ -f ${quoted}/old-binary ] && [ ! -f ${quoted}/rollback-completed ]; then
  printf kept
else
  rm -rf -- ${quoted}
fi`)).then((result) => result === 'kept', () => true);

    if (retained) {
      throw new Error('remote_rollback_failed');
    }

    throw error;
  }
}

/**
 * Intent и копии предыдущего поколения записываются до первой замены.
 * Trap сохраняет прежние bytes, права и состояние службы при локальной ошибке shell.
 */
function installScript(job: DeploymentJob, staging: string): string {
  const id = job.relayId!;
  const unitName = `grigdesk-relay-${id}.service`;

  return `set -eu
exec 9>/run/grigdesk-relay-${job.public.port}.lock
flock -n 9
${ownership(job)}
stage=${shellQuote(staging)}
name=grigdesk-relay-${id}
old=no
active=no
enabled=no
# Остатки прерванной первой установки без прежних файлов идут в свежую ветку.
if [ -f "$state/owner" ] && [ -f "$base/grigdesk-relay" ] && [ -f "$conf/relay.env" ] \
  && [ -f "$unit" ]; then
  old=yes
  cp -p "$base/grigdesk-relay" "$stage/old-binary"
  cp -p "$conf/relay.env" "$stage/old-env"
  cp -p "$unit" "$stage/old-unit"
  if systemctl is-active ${unitName} >/dev/null; then active=yes; fi
  if systemctl is-enabled ${unitName} >/dev/null; then enabled=yes; fi
  if [ "$active" = yes ] && [ "$enabled" = yes ] \
    && cmp -s "$stage/binary" "$base/grigdesk-relay" \
    && cmp -s "$stage/relay.env" "$conf/relay.env" && cmp -s "$stage/unit" "$unit"; then
    printf '%s\\n' unchanged
    exit 0
  fi
else
  mkdir -p "$base" "$conf" "$state"
  chmod 755 "$base"
  chmod 700 "$conf" "$state"
  printf '%s\\n' '${job.expectedServerFp}:${id}' > "$state/owner"
  chmod 600 "$state/owner"
fi
printf '%s\\n' installing > "$state/phase"
printf '%s\\n' "$active" > "$stage/active"
printf '%s\\n' "$enabled" > "$stage/enabled"
rollback() {
  trap - EXIT HUP INT TERM
  rm -f "$base/grigdesk-relay.next" "$conf/relay.env.next" "$unit.next"
  if [ "$old" = yes ]; then
${restorePrevious(job)}
  else
    systemctl stop ${unitName} || true
    systemctl disable ${unitName} || true
    rm -f "$unit"
    rm -f "$base/grigdesk-relay" "$conf/relay.env"
    rm -f "$state/owner" "$state/phase"
    systemctl daemon-reload || true
    # Повторная установка того же relay должна проходить без ручной чистки VPS.
    userdel grigdesk-relay-${id} 2>/dev/null || true
    groupdel grigdesk-relay-${id} 2>/dev/null || true
    rmdir "$base" "$conf" "$state" 2>/dev/null || true
  fi
  if [ -d "$state" ]; then printf '%s\\n' recovery_required > "$state/phase"; fi
  printf '%s\\n' restored > "$stage/rollback-completed"
  exit 1
}
trap rollback EXIT HUP INT TERM
if ! getent passwd "$name" >/dev/null; then
  useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$name"
fi
install -m 755 "$stage/binary" "$base/grigdesk-relay.next"
install -m 600 "$stage/relay.env" "$conf/relay.env.next"
install -m 644 "$stage/unit" "$unit.next"
mv "$base/grigdesk-relay.next" "$base/grigdesk-relay"
mv "$conf/relay.env.next" "$conf/relay.env"
mv "$unit.next" "$unit"
systemctl daemon-reload
systemctl enable ${unitName}
if [ "$active" = yes ]; then
  systemctl restart ${unitName}
else
  systemctl start ${unitName}
fi
systemctl is-active ${unitName} >/dev/null
printf '%s\\n' installed > "$state/phase"
trap - EXIT HUP INT TERM
printf 'previous=%s\\nactive=%s\\n' "$old" "$active"`;
}

/**
 * Возвращает прежние файлы атомарной заменой и восстанавливает активность и автозапуск.
 * Тот же фрагмент применяется при отказе shell и после неудачного сетевого доказательства.
 */
function restorePrevious(job: DeploymentJob): string {
  const unitName = `grigdesk-relay-${job.relayId}.service`;

  return `systemctl stop ${unitName}
cp -p "$stage/old-binary" "$base/grigdesk-relay.rollback"
cp -p "$stage/old-env" "$conf/relay.env.rollback"
cp -p "$stage/old-unit" "$unit.rollback"
mv "$base/grigdesk-relay.rollback" "$base/grigdesk-relay"
mv "$conf/relay.env.rollback" "$conf/relay.env"
mv "$unit.rollback" "$unit"
restored=yes
systemctl daemon-reload || restored=no
if [ "$enabled" = yes ]; then
  systemctl enable ${unitName} || restored=no
else
  systemctl disable ${unitName} || restored=no
fi
if [ "$active" = yes ]; then systemctl start ${unitName} || restored=no; fi
test "$restored" = yes`;
}

/**
 * Откат после сетевого отказа допускается лишь для всё ещё установленного нами поколения.
 * Изменённые кем-то другим файлы не затираются; потерянный SSH даёт явный recovery_required.
 */
function rollbackScript(job: DeploymentJob, staging: string): string {
  return `set -eu
exec 9>/run/grigdesk-relay-${job.public.port}.lock
flock -n 9
${ownership(job, false)}
stage=${shellQuote(staging)}
cmp -s "$stage/binary" "$base/grigdesk-relay"
cmp -s "$stage/relay.env" "$conf/relay.env"
cmp -s "$stage/unit" "$unit"
active=$(cat "$stage/active")
enabled=$(cat "$stage/enabled")
${restorePrevious(job)}
printf '%s\\n' restored > "$state/phase"`;
}
