import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { shellQuote } from '../../../../../shared/lib/shellQuote.ts';
import type { DeploymentJob } from '../../../../../shared/mobile/relayDeploymentContracts.ts';
import { sha256File } from '../../../../../shared/node/hash.ts';
import type { SshTransportSession } from '../../ssh/transport.ts';
import type { RelayArtifact } from './artifact.ts';
import { ownership, preflight } from './preflight.ts';
import { command, upload } from './sshClient.ts';

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
): Promise<void> {
  if (await sha256File(artifact.file) !== artifact.digest) {
    throw new Error('relay_artifact_corrupt');
  }

  const root = await preflight(session, job);
  const staging = `/tmp/grigdesk-relay-${randomUUID()}`;
  const quoted = shellQuote(staging);

  await command(session, `umask 077; mkdir ${quoted}`);

  try {
    await upload(session, `${staging}/binary`, await readFile(artifact.file));
    await upload(session, `${staging}/relay.env`, Buffer.from(`RELAY_PORT=${job.public.port}\n${env}`));
    await upload(session, `${staging}/unit`, Buffer.from(serviceUnit(job)));
    await command(session, `set -eu
chmod 755 ${quoted}/binary
printf '%s  %s\\n' '${artifact.digest}' ${quoted}/binary | sha256sum -c - >/dev/null
${quoted}/binary --version >/dev/null`);
    await command(session, `${root ? '' : 'sudo -n '}sh -c ${shellQuote(installScript(job, staging))}`);
  } finally {
    await command(session, `rm -rf -- ${quoted}`).catch(() => {});
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
else
  mkdir -p "$base" "$conf" "$state"
  chmod 755 "$base"
  chmod 700 "$conf" "$state"
  printf '%s\\n' '${job.expectedServerFp}:${id}' > "$state/owner"
  chmod 600 "$state/owner"
fi
printf '%s\\n' installing > "$state/phase"
rollback() {
  trap - EXIT HUP INT TERM
  if [ "$old" = yes ]; then
    cp -p "$stage/old-binary" "$base/grigdesk-relay"
    cp -p "$stage/old-env" "$conf/relay.env"
    cp -p "$stage/old-unit" "$unit"
    systemctl daemon-reload || true
    if [ "$enabled" = yes ]; then systemctl enable ${unitName} || true; fi
    if [ "$active" = yes ]; then systemctl start ${unitName} || true; fi
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
  printf '%s\\n' recovery_required > "$state/phase"
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
systemctl start ${unitName}
systemctl is-active ${unitName} >/dev/null
printf '%s\\n' installed > "$state/phase"
trap - EXIT HUP INT TERM`;
}
