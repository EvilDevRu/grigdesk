import path from 'node:path';

import type { CliArgs } from './args.ts';
import type { Settings } from './commands.ts';
import { printable } from './status.ts';
import { fetchJson, readText, run } from './system.ts';
import { plainOutput } from './output.ts';
import type { CliOutput } from './output.ts';
import type { RunResult } from './system.ts';

export interface RelayContainer {
  name: string;
  project: string;
  configFiles: string;
}

export type RelayStateName = 'ready' | 'starting' | 'unhealthy' | 'stopped' | 'not_deployed'
  | 'ambiguous' | 'docker_unavailable';
export type LinkStateName = 'online' | 'connecting' | 'waiting_vpn' | 'offline' | 'error' | 'unknown';

export interface RelayStatus {
  state: RelayStateName;
  container: string | null;
  reason: string | null;
  links: { name: string; state: LinkStateName }[] | null;
}

const LIST_FORMAT = '{{.Names}}\t{{.Label "com.docker.compose.project"}}\t' +
  '{{.Label "com.docker.compose.project.config_files"}}';
const STATE_FORMAT = '{{.State.Status}}\t{{if .State.Health}}{{.State.Health.Status}}{{end}}';
const LINK_STATES = ['online', 'connecting', 'waiting_vpn', 'offline', 'error'];

/**
 * Разбирает три поля формата Docker, сохраняя config_files целиком.
 * Несколько файлов compose остаются одним значением и не принимаются за эту установку.
 */
export function parseRelayList(text: string): RelayContainer[] {
  return text.split('\n').filter(Boolean).map((line) => {
    const [name = '', project = '', configFiles = ''] = line.split('\t');

    return {
      name,
      project,
      configFiles,
    };
  });
}

/**
 * Выбирает точный compose-файл этой копии либо проект, заданный человеком.
 * Неоднозначность сохраняется как данные и никогда не разрешается первым контейнером.
 */
export function pickRelay(
  list: readonly RelayContainer[],
  options: { composeFile: string; project: string | null },
): { kind: 'one'; container: RelayContainer } | { kind: 'none' } | { kind: 'many'; names: string[] } {
  const matches = list.filter((container) => options.project
    ? container.project === options.project : container.configFiles === options.composeFile);

  if (!matches.length) {
    return { kind: 'none' };
  }

  if (matches.length > 1) {
    return {
      kind: 'many',
      names: matches.map((container) => container.name),
    };
  }

  return {
    kind: 'one',
    container: matches[0]!,
  };
}

/**
 * Готовность контейнера учитывает состояние процесса и необязательный healthcheck.
 * Restarting и запуск проверки показываются как переходное состояние.
 */
export function relayState(inspectLine: string): RelayStateName {
  const [state, health = ''] = inspectLine.trimEnd().split('\t');

  if (state === 'restarting' || state === 'running' && health === 'starting') {
    return 'starting';
  }

  if (state === 'running' && health === 'unhealthy') {
    return 'unhealthy';
  }

  return state === 'running' && (health === '' || health === 'healthy') ? 'ready' : 'stopped';
}

/**
 * Отсутствующий клиент Docker отличается от недоступного daemon или отказа команды.
 * В причину попадает только очищенная первая строка stderr, без управляющих символов.
 */
export function dockerProblem(result: RunResult): { state: RelayStateName; reason: string } | null {
  if (result.missing) {
    return {
      state: 'not_deployed',
      reason: 'Docker не установлен',
    };
  }

  if (result.code !== 0) {
    const first = printable(result.stderr.split('\n')[0]?.trim() || 'нет ответа');

    return {
      state: 'docker_unavailable',
      reason: `Docker недоступен: ${first}`,
    };
  }

  return null;
}

/**
 * Принимает только массив посредников с именами и состояниями link.
 * Устройства и прочие поля ответа не пересекают публичную границу статуса CLI.
 */
export function parseLinks(body: unknown): { name: string; state: LinkStateName }[] | null {
  if (!body || typeof body !== 'object' || !('relays' in body) || !Array.isArray(body.relays)) {
    return null;
  }

  const links: { name: string; state: LinkStateName }[] = [];

  for (const relay of body.relays as unknown[]) {
    if (!relay || typeof relay !== 'object' || !('name' in relay) || typeof relay.name !== 'string' ||
      !('link' in relay) || !relay.link || typeof relay.link !== 'object' || !('state' in relay.link)) {
      return null;
    }

    const state = relay.link.state;

    links.push({
      name: printable(relay.name),
      state: typeof state === 'string' && LINK_STATES.includes(state) ? state as LinkStateName : 'unknown',
    });
  }

  return links;
}

/**
 * Сначала читает список локальных контейнеров, затем inspect ровно выбранного.
 * Docker не разворачивает новые контейнеры, а неоднозначность возвращается пользователю.
 */
export async function readRelay(root: string, settings: Settings): Promise<RelayStatus> {
  const list = await run('docker', [
    'ps', '-a', '--filter', 'label=com.docker.compose.service=relay', '--format', LIST_FORMAT,
  ], 5000);
  const problem = dockerProblem(list);
  const empty = {
    container: null,
    links: null,
  };

  if (problem) {
    return {
      ...problem,
      ...empty,
    };
  }

  const selection = pickRelay(parseRelayList(list.stdout), {
    composeFile: path.join(root, 'relay/compose.yaml'),
    project: settings.relayProject,
  });

  if (selection.kind === 'none') {
    return {
      state: 'not_deployed',
      reason: 'Локальный посредник не найден: docs/grigdesk/mobile/relay-deploy.md',
      ...empty,
    };
  }

  if (selection.kind === 'many') {
    return {
      state: 'ambiguous',
      reason: `Найдено несколько посредников: ${selection.names.map(printable).join(', ')}. ` +
        'Выберите GRIGDESK_RELAY_PROJECT в .env',
      ...empty,
    };
  }

  const name = selection.container.name;
  const inspect = await run('docker', ['inspect', '--format', STATE_FORMAT, name], 5000);
  const inspectProblem = dockerProblem(inspect);

  return {
    state: inspectProblem?.state ?? relayState(inspect.stdout),
    container: name,
    reason: inspectProblem?.reason ?? null,
    links: null,
  };
}

/**
 * Связи читаются только после доказанной готовности сервера вызывающей стороной.
 * Токен используется лишь в заголовке запроса и никогда не выводится в ошибке.
 */
export async function readLinks(settings: Settings): Promise<RelayStatus['links']> {
  const token = (await readText(settings.cliTokenPath))?.trim();

  if (!token) {
    return null;
  }

  return parseLinks(await fetchJson(settings.origin + '/api/mobile/status',
    { 'X-GrigDesk-Token': token }, 3000));
}

/**
 * Управляет существующим выбранным контейнером только прямыми командами Docker.
 * Отсутствие, неоднозначность и отказ daemon прекращают команду до управляющего действия.
 */
export async function relayCommand(
  args: CliArgs, root: string, settings: Settings, output: CliOutput = plainOutput,
): Promise<number> {
  const relay = await readRelay(root, settings);
  const name = relay.container;

  if (!name || relay.state === 'docker_unavailable') {
    output.error(printable(relay.reason ?? 'Локальный посредник не найден') + '\n');

    return 1;
  }

  if (args.action === 'logs') {
    return output.attached('docker', [
      'logs', '--tail', String(args.lines), ...(args.follow ? ['--follow'] : []), name,
    ]);
  }

  if (args.action === 'start' && relay.state !== 'stopped') {
    output.write('Посредник уже работает\n');

    return 0;
  }

  if (args.action === 'stop' && relay.state === 'stopped') {
    output.write('Посредник уже остановлен\n');

    return 0;
  }

  const result = await run('docker', [args.action!, name], 60000);

  if (result.code !== 0) {
    output.error(printable(result.stderr.trim() || 'Docker отказал в выполнении команды') + '\n');

    return 1;
  }

  const word = args.action === 'start' ? 'запущен' : args.action === 'stop' ? 'остановлен' : 'перезапущен';

  output.write(`Посредник ${word}\n`);

  return 0;
}
