import { shellQuote } from '../../../../../shared/lib/shellQuote.ts';
import type { DeploymentJob } from '../../../../../shared/mobile/relayDeploymentContracts.ts';
import { compareProductVersions } from '../../../../../shared/runtime/productReleaseVersion.ts';
import type { SshTransportSession } from '../../ssh/transport.ts';

import type { ArtifactBinding } from './artifact.ts';
import { ownership } from './preflight.ts';
import { command } from './sshClient.ts';

export interface ReleaseFloor {
  version: string;
  releaseId: string;
  manifestSha: string;
}

export interface RemoteFiles {
  binary: string;
  env: string;
  unit: string;
}

export interface RemoteState extends RemoteFiles {
  inodes: RemoteFiles;
  intent: string;
  published: string;
  gate: string;
  proof: string;
  floor?: ReleaseFloor;
}

/**
 * Сверяет номер и точную подписанную цель, если установлен такой же номер.
 * Одинаковая версия допускает повтор теми же файлами после сбоя.
 */
export function assertReleaseFloor(target: ReleaseFloor, floor?: ReleaseFloor): void {
  if (!floor) {
    return;
  }

  const order = compareProductVersions(target.version, floor.version);

  if (order < 0 || order === 0 && (target.releaseId !== floor.releaseId
    || target.manifestSha !== floor.manifestSha)) {
    throw new Error('relay_release_floor');
  }
}

/**
 * Системные пути и блокировки общие для осмотра и установки. Смена публичного порта
 * не меняет блокировку identity. Под ней дополнительно защищён целевой порт.
 */
export function remotePaths(job: DeploymentJob): string {
  if (!/^r[a-f0-9]{8,32}$/.test(job.relayId ?? '')
    || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(job.id)) {
    throw new Error('remote_installation_conflict');
  }

  return `set -eu
umask 077
exec 8>/run/grigdesk-relay-${job.relayId}.lock
flock -n 8
exec 9>/run/grigdesk-relay-${job.public.port}.lock
flock -n 9
${ownership(job)}
binary="$base/grigdesk-relay"
env_file="$conf/relay.env"
intent="$state/intent.json"
published="$state/published"
floor="$state/floor.json"
name=grigdesk-relay-${job.relayId}
unit_name="$name.service"
checked_hash() {
  file=$1
  expected=$2
  test ! -L "$file"
  if [ ! -e "$file" ]; then
    printf absent
    return
  fi
  test -f "$file"
  test "$(stat -c '%u:%a' -- "$file")" = "0:$expected"
  value=$(sha256sum -- "$file")
  printf '%s' "\${value%% *}"
}
binary_hash=$(checked_hash "$binary" 755)
env_hash=$(checked_hash "$env_file" 600)
unit_hash=$(checked_hash "$unit" 644)
intent_hash=$(checked_hash "$intent" 600)
published_hash=$(checked_hash "$published" 600)
floor_hash=$(checked_hash "$floor" 600)
gate_hash=$(checked_hash "$base/gate.json" 644)
proof_hash=$(checked_hash "$base/proof.json" 640)
file_id() {
  if [ -e "$1" ]; then stat -c '%d:%i' -- "$1"; else printf absent; fi
}
binary_id=$(file_id "$binary")
env_id=$(file_id "$env_file")
unit_id=$(file_id "$unit")
if [ -e "$state" ]; then
  test "$(stat -c '%u:%a' -- "$state")" = 0:700
  test "$(stat -c '%u:%a' -- "$state/owner")" = 0:600
  test ! -L "$state/owner"
fi
for directory in "$base:755" "$conf:700"; do
  name_path=\${directory%:*}
  if [ -e "$name_path" ]; then
    test "$(stat -c '%u:%a' -- "$name_path")" = "0:\${directory##*:}"
  fi
done`;
}

/**
 * Возвращает только хеши и публичную связь с выпуском. Секреты VPS остаются на месте.
 * При несовпадении прав или формы данных снимок не пригоден для записи.
 */
export async function inspectRemote(session: SshTransportSession, job: DeploymentJob,
  root: boolean): Promise<RemoteState> {
  const output = await remoteCommand(session, root, `${remotePaths(job)}
printf '%s\\n' "$binary_hash" "$env_hash" "$unit_hash" "$intent_hash"
printf '%s\\n' "$published_hash" "$gate_hash" "$proof_hash"
printf '%s\\n' "$binary_id" "$env_id" "$unit_id"
if [ "$floor_hash" != absent ]; then cat "$floor"; fi`);

  const [binary = '', env = '', unit = '', intent = '', published = '', gate = '', proof = '',
    binaryId = '', envId = '', unitId = '', floor] = output.trimEnd().split('\n');
  const fields = [binary, env, unit, intent, published, gate, proof];

  if (fields.some((field) => !/^(absent|[a-f0-9]{64})$/.test(field ?? ''))
    || [binaryId, envId, unitId].some((id) => !/^(absent|\d+:\d+)$/.test(id ?? ''))) {
    throw new Error('remote_installation_conflict');
  }

  return {
    binary,
    env,
    unit,
    inodes: {
      binary: binaryId,
      env: envId,
      unit: unitId,
    },
    intent,
    published,
    gate,
    proof,
    floor: floor ? decodeFloor(floor) : undefined,
  };
}

function decodeFloor(text: string): ReleaseFloor {
  const value = JSON.parse(text) as ReleaseFloor;

  if (!value || typeof value.version !== 'string' || typeof value.releaseId !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.manifestSha)) {
    throw new Error('remote_installation_conflict');
  }

  return value;
}

/**
 * Сохраняет идентификаторы выпуска для сравнения следующего обновления.
 * Место хранения архива и ключ доказательства для сравнения не нужны.
 */
export function floorOf(binding: ArtifactBinding): ReleaseFloor {
  return {
    version: binding.version,
    releaseId: binding.releaseId,
    manifestSha: binding.manifestSha,
  };
}

/**
 * Отправляет проверенный shell-фрагмент с полномочиями, подтверждёнными на preflight.
 * Для непривилегированного пользователя используется только sudo без запроса пароля.
 */
export function remoteCommand(session: SshTransportSession, root: boolean, script: string): Promise<string> {
  return command(session, `${root ? '' : 'sudo -n '}sh -c ${shellQuote(script)}`);
}
