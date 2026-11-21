import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { shellQuote } from '../../../../../shared/lib/shellQuote.ts';
import type { DeploymentJob } from '../../../../../shared/mobile/relayDeploymentContracts.ts';
import type { HostKey } from '../../ssh/hostKeys.ts';
import type { SshTransportSession } from '../../ssh/transport.ts';

import type { ArtifactBinding, RelayArtifact } from './artifact.ts';
import type { DeploymentProof } from './candidate.ts';
import { preflight } from './preflight.ts';
import { assertReleaseFloor, floorOf, inspectRemote, remoteCommand, remotePaths } from './remoteState.ts';
import type { RemoteFiles, RemoteState } from './remoteState.ts';
import { command, upload } from './sshClient.ts';

export interface UpdateRecovery {
  schema: 1;
  jobId: string;
  relayId: string;
  revision: number;
  hostKey: HostKey;
  endpoint: DeploymentJob['public'];
  binding: ArtifactBinding;
  old: RemoteState;
  preserveSettings: boolean;
  proof: DeploymentProof;
  published?: {
    digest: string;
    endpoint: DeploymentJob['public'];
    reason?: 'awaiting_dns' | 'waiting_vpn';
  };
}

/**
 * Считает контрольную сумму в том же виде, в котором её возвращает VPS.
 * Для записей используется точная строка, записанная на диск.
 */
export function digest(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Формирует службу без прав root и с capability только для привилегированного порта.
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

interface InstallationFiles {
  expected: RemoteFiles;
  intent: string;
  env: string;
  unit: string;
  blocked: string;
  approved: string;
  proof: string;
}

/**
 * Вычисляет ожидаемые байты до эффекта, чтобы каждый повтор проверял одну и ту же цель.
 * Существующие настройки неизменившегося endpoint входят в опись своими хешами.
 */
function renderFiles(
  job: DeploymentJob, pin: UpdateRecovery, env: string, certFingerprint: string,
): InstallationFiles {
  const environment = `RELAY_PORT=${job.public.port}\n${env}`;
  const unit = serviceUnit(job);
  const expected = {
    binary: pin.binding.fileSha,
    env: pin.preserveSettings ? pin.old.env : digest(environment),
    unit: pin.preserveSettings ? pin.old.unit : digest(unit),
  };
  const gate = {
    schema: 1,
    generation: job.id,
    jobId: job.id,
    targetSha: expected.binary,
    relayId: pin.relayId,
    host: '0.0.0.0',
    port: pin.endpoint.port,
    certFingerprint,
  };
  const intent = JSON.stringify({
    schema: 1,
    phase: 'prepared',
    jobId: pin.jobId,
    relayId: pin.relayId,
    uid: 0,
    endpoint: pin.endpoint,
    ssh: pin.hostKey,
    before: pin.old,
    after: expected,
    binary: `/opt/grigdesk-relay/${pin.relayId}/grigdesk-relay`,
    env: `/etc/grigdesk-relay/${pin.relayId}/relay.env`,
    unit: `/etc/systemd/system/grigdesk-relay-${pin.relayId}.service`,
    binding: floorOf(pin.binding),
  });

  return {
    expected,
    intent,
    env: environment,
    unit,
    blocked: JSON.stringify({ ...gate, status: 'blocked' }),
    approved: JSON.stringify({ ...gate, status: 'approved' }),
    proof: JSON.stringify({
      ...pin.proof,
      schema: 1,
      jobId: job.id,
    }),
  };
}

/**
 * Публикует единственное поколение. Повтор состояния B/B/B запускает проверку B
 * без повторного SFTP; частично записанные состояния проходят те же проверки и fence.
 */
export async function installRelay(session: SshTransportSession, job: DeploymentJob,
  artifact: RelayArtifact, pin: UpdateRecovery, env: string, certFingerprint: string): Promise<void> {
  const root = await preflight(session, job);
  const files = renderFiles(job, pin, env, certFingerprint);
  const disk = await inspectRemote(session, job, root);
  const intentHash = digest(files.intent);

  if (disk.intent !== pin.old.intent && disk.intent !== intentHash) {
    throw new Error('remote_installation_conflict');
  }

  assertReleaseFloor(pin.binding, disk.floor);

  if (disk.intent === intentHash && disk.gate === digest(files.approved) && disk.proof === digest(files.proof)
    && disk.binary === files.expected.binary && disk.env === files.expected.env
    && disk.unit === files.expected.unit) {
    await remoteCommand(session, root, activation(job, pin, files, false));

    return;
  }

  const stage = `/tmp/grigdesk-relay-${randomUUID()}`;
  const quoted = shellQuote(stage);

  await command(session, `umask 077; mkdir ${quoted}`);

  try {
    const bytes = await readFile(artifact.file);

    if (digest(bytes) !== files.expected.binary) {
      throw new Error('relay_artifact_corrupt');
    }

    await upload(session, `${stage}/binary`, bytes);

    if (!pin.preserveSettings) {
      await upload(session, `${stage}/relay.env`, Buffer.from(files.env));
      await upload(session, `${stage}/unit`, Buffer.from(files.unit));
    }

    await upload(session, `${stage}/proof.json`, Buffer.from(files.proof));
    await checkCandidate(session, quoted, pin.binding);
    await remoteCommand(session, root, publication(job, pin, files, stage));
  } finally {
    await command(session, `rm -rf -- ${quoted}`).catch(() => {});
  }
}

/**
 * Проверенный файл сам сообщает имя, runtime и версию до любой публикации на VPS.
 */
async function checkCandidate(
  session: SshTransportSession, stage: string, binding: ArtifactBinding,
): Promise<void> {
  const output = await command(session, `set -eu
chmod 755 ${stage}/binary
printf '%s  %s\\n' ${shellQuote(binding.fileSha)} ${stage}/binary | sha256sum -c - >/dev/null
${stage}/binary --runtime-info --json`);
  const info = JSON.parse(output);

  if (info?.schema !== 1 || info.kind !== 'grigdesk-relay' || info.version !== binding.version
    || info.runtime !== 'go' || info.os !== 'linux' || info.arch !== 'amd64') {
    throw new Error('relay_artifact_incompatible');
  }
}

function publication(
  job: DeploymentJob, pin: UpdateRecovery, files: InstallationFiles, stage: string,
): string {
  const old = pin.old;
  const next = files.expected;

  return `${remotePaths(job)}
stage=${shellQuote(stage)}
${atomicFiles}
${assertOrder(pin, files)}
if [ "$intent_hash" != ${shellQuote(digest(files.intent))} ]; then
  [ "$binary_hash/$env_hash/$unit_hash" = ${shellQuote([old.binary, old.env, old.unit].join('/'))} ]
  [ "$published_hash/$gate_hash/$proof_hash" = ${shellQuote([old.published, old.gate, old.proof].join('/'))} ]
  if [ ! -d "$state" ]; then
    mkdir -p /var/lib/grigdesk-relay
    pending=$(mktemp -d /var/lib/grigdesk-relay/.prepare-${job.id}.XXXXXXXX)
    printf '%s' ${shellQuote(`${job.expectedServerFp}:${pin.relayId}`)} > "$pending/owner"
    printf '%s' ${shellQuote(files.intent)} > "$pending/intent.json"
    sync -f "$pending"
    mv -T -- "$pending" "$state"
    sync -f /var/lib/grigdesk-relay
  else
    write_text "$intent" 600 ${shellQuote(files.intent)}
  fi
fi
mkdir -p /opt/grigdesk-relay /etc/grigdesk-relay
if [ ! -d "$base" ]; then install -d -m 755 "$base"; fi
if [ ! -d "$conf" ]; then install -d -m 700 "$conf"; fi
if ! getent passwd "$name" >/dev/null; then
  useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$name"
fi
write_text "$base/gate.json" 644 ${shellQuote(files.blocked)}
if [ "$unit_hash" != absent ]; then
  systemctl stop "$unit_name"
  ! systemctl is-active "$unit_name" >/dev/null || exit 1
  jobs=$(systemctl list-jobs --no-pager --no-legend)
  if printf '%s\\n' "$jobs" | awk -v unit="$unit_name" '$2 == unit {found=1} END {exit !found}'; then
    exit 1
  fi
fi
if [ "$binary_hash" != ${shellQuote(next.binary)} ]; then
  publish_file "$stage/binary" "$binary" 755 ${shellQuote(next.binary)}
fi
if [ "$env_hash" != ${shellQuote(next.env)} ]; then
  publish_file "$stage/relay.env" "$env_file" 600 ${shellQuote(next.env)}
fi
if [ "$unit_hash" != ${shellQuote(next.unit)} ]; then
  publish_file "$stage/unit" "$unit" 644 ${shellQuote(next.unit)}
fi
copy_proof "$stage/proof.json" "$base/proof.json" ${shellQuote(digest(files.proof))}
${startVerified(pin, files, true)}`;
}

/**
 * Разрешает только последовательные стадии замены и проверяет inode исходных файлов.
 * При неизменившихся байтах inode должен совпасть с первоначальным снимком.
 */
function assertOrder(pin: UpdateRecovery, files: InstallationFiles): string {
  const old = pin.old;
  const next = files.expected;
  const assertOriginalFiles = (['binary', 'env', 'unit'] as const).map((name) => `
if [ "$intent_hash" != ${shellQuote(digest(files.intent))} ] \
 || [ "$${name}_hash" != ${shellQuote(next[name])} ] \
 || [ ${shellQuote(old[name])} = ${shellQuote(next[name])} ]; then
  test "$${name}_id" = ${shellQuote(old.inodes[name])}
fi`).join('');

  return `case "$intent_hash" in
  ${shellQuote(old.intent)}|${shellQuote(digest(files.intent))}) ;;
  *) exit 1 ;;
esac
case "$binary_hash/$env_hash/$unit_hash" in
  ${[old.binary, old.env, old.unit].join('/')}|\
  ${[next.binary, old.env, old.unit].join('/')}|\
  ${[next.binary, next.env, old.unit].join('/')}|\
  ${[next.binary, next.env, next.unit].join('/')}) ;;
  *) exit 1 ;;
esac
${assertOriginalFiles}`;
}

function activation(
  job: DeploymentJob, pin: UpdateRecovery, files: InstallationFiles, reload: boolean,
): string {
  return `${remotePaths(job)}
${atomicFiles}
${startVerified(pin, files, reload)}`;
}

/**
 * Разрешает запуск только после проверки всех файлов, effective unit и gate.
 * Долговременная отметка подтверждается локальной проверкой здоровья.
 */
function startVerified(pin: UpdateRecovery, files: InstallationFiles, reload: boolean): string {
  const { binary, env, unit } = files.expected;
  const approvedHash = digest(files.approved);
  const proofHash = digest(files.proof);
  const release = JSON.stringify(floorOf(pin.binding));
  const verify = `test "$(checked_hash "$intent" 600)" = ${shellQuote(digest(files.intent))}
test "$(checked_hash "$binary" 755)" = ${shellQuote(binary)}
test "$(checked_hash "$env_file" 600)" = ${shellQuote(env)}
test "$(checked_hash "$unit" 644)" = ${shellQuote(unit)}
test "$(checked_hash "$base/proof.json" 640)" = ${shellQuote(proofHash)}`;
  const prepare = reload ? `systemctl daemon-reload
${verifyUnit}
systemctl enable "$unit_name"
write_text "$floor" 600 ${shellQuote(release)}
write_text "$base/gate.json" 644 ${shellQuote(files.approved)}` : '';

  return `${verify}
${prepare}
${reload ? '' : verifyUnit}
test "$(checked_hash "$base/gate.json" 644)" = ${shellQuote(approvedHash)}
test "$(checked_hash "$floor" 600)" = ${shellQuote(digest(release))}
systemctl start "$unit_name"
systemctl is-active "$unit_name" >/dev/null
tries=0
until RELAY_PORT=${pin.endpoint.port} "$binary" --healthcheck; do
  tries=$((tries + 1))
  test "$tries" -lt 15
  sleep 0.25
done
write_text "$published" 600 ${shellQuote(digest(files.intent))}`;
}

const verifyUnit = `test "$(systemctl show --property=FragmentPath --value "$unit_name")" = "$unit"
test "$(systemctl show --property=User --value "$unit_name")" = "$name"
test "$(systemctl show --property=Group --value "$unit_name")" = "$name"
test -z "$(systemctl show --property=DropInPaths --value "$unit_name")"
test "$(systemctl show --property=EnvironmentFiles --value "$unit_name")" = "$env_file (ignore_errors=no)"
case "$(systemctl show --property=ExecStart --value "$unit_name")" in
  "{ path=$binary ; argv[]=$binary ; "*) ;;
  *) exit 1 ;;
esac`;

const atomicFiles = `publish_file() {
  source_file=$1
  destination=$2
  mode=$3
  expected=$4
  temporary=$(mktemp "${'$'}destination.next.XXXXXXXX")
  install -m "$mode" -- "$source_file" "$temporary"
  test "$(checked_hash "$temporary" "$mode")" = "$expected"
  sync -f "$temporary"
  mv -T -- "$temporary" "$destination"
  sync -f "$(dirname -- "$destination")"
}
write_text() {
  destination=$1
  mode=$2
  text=$3
  temporary=$(mktemp "${'$'}destination.next.XXXXXXXX")
  printf '%s' "$text" > "$temporary"
  chmod "$mode" "$temporary"
  sync -f "$temporary"
  mv -T -- "$temporary" "$destination"
  sync -f "$(dirname -- "$destination")"
}
copy_proof() {
  destination=$2
  temporary=$(mktemp "${'$'}destination.next.XXXXXXXX")
  install -m 640 -- "$1" "$temporary"
  chown "root:$name" "$temporary"
  test "$(checked_hash "$temporary" 640)" = "$3"
  sync -f "$temporary"
  mv -T -- "$temporary" "$destination"
  sync -f "$(dirname -- "$destination")"
}`;
