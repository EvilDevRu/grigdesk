import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { isRecord } from '../../../../shared/lib/objects.ts';

import type { RouteDraft, RouteEditorIssue } from '../../../../shared/pipeline/routesEditorContracts.ts';
import { parseRouteMap } from '../../lib/analysis/routePolicy.ts';
import { loadRunnerConfig } from '../../lib/runnerState.ts';

import { assertProfileId } from './schema.ts';

const runCli = promisify(execFile);
const ROUTE_CLI = fileURLToPath(new URL('../../../../engine/bin/factory-route', import.meta.url));
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const CONTEXT_RE = /^[a-z][a-zA-Z0-9]{0,40}$/;
const FILESYSTEM = new Set(['state-only', 'workspace-write']);

export interface EditorCommandCapability {
  id: string;
  label: string;
  filesystem: string[];
}

export interface EditorContextSection {
  id: string;
  label: string;
}

export interface EditorCapabilities {
  schema: 1;
  commands: EditorCommandCapability[];
  contextSections: EditorContextSection[];
  filesystem: string[];
  timeoutClasses: string[];
  retryStrategies: string[];
}

export interface EditorCapabilitiesSnapshot {
  capabilities: EditorCapabilities;
  capabilitiesHash: string | null;
  issues: RouteEditorIssue[];
  profileAvailable: boolean;
  externalRouteIds: string[];
  nativeFanoutRunners: string[];
  runnerChain: string[];
}

function profileIssue(code: string, message: string, pathName = '/profile'): RouteEditorIssue {
  return {
    code,
    severity: 'error',
    scope: 'profile',
    routeId: null,
    nodeId: null,
    path: pathName,
    message,
  };
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

/**
 * Получает известные движку секции и политики из его чистого CLI без profile.sh.
 */
async function engineBuiltins(profile: string) {
  const { stdout } = await runCli(ROUTE_CLI, ['--profile', profile, 'editor-capabilities'], {
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  const value = JSON.parse(stdout) as Record<string, unknown>;
  if (value.schema !== 1 || !Array.isArray(value.contextSections)
    || !Array.isArray(value.filesystem) || !Array.isArray(value.timeoutClasses)
    || !Array.isArray(value.retryStrategies)
    || !Array.isArray(value.nativeFanoutRunners)) {
    throw new Error('Движок вернул недопустимые возможности');
  }
  return value as unknown as Pick<
    EditorCapabilities,
    'contextSections' | 'filesystem' | 'timeoutClasses' | 'retryStrategies'
  > & {
    nativeFanoutRunners: string[];
  };
}

/**
 * Читает только обычный небольшой JSON; отсутствие manifest разрешает agent-only route.
 */
async function readManifest(file: string): Promise<{
  commands: EditorCommandCapability[];
  contextSections: EditorContextSection[];
} | null> {
  let info;
  try {
    info = await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) {
    throw new Error('Manifest должен быть обычным небольшим файлом');
  }
  const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!exactKeys(value, ['schema', 'commands', 'contextSections'])
    || value.schema !== 1 || !Array.isArray(value.commands)
    || !Array.isArray(value.contextSections)
    || value.commands.length > 128 || value.contextSections.length > 64) {
    throw new Error('Неверная версия или поля manifest');
  }
  const commandIds = new Set<string>();
  const commands: EditorCommandCapability[] = [];
  for (const item of value.commands) {
    if (!exactKeys(item, ['id', 'label', 'filesystem'])
      || typeof item.id !== 'string' || !ID_RE.test(item.id)
      || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 100
      || !Array.isArray(item.filesystem) || item.filesystem.length === 0
      || item.filesystem.some((policy) => !FILESYSTEM.has(policy))
      || new Set(item.filesystem).size !== item.filesystem.length
      || commandIds.has(item.id)) {
      throw new Error('Неверное объявление команды');
    }
    commandIds.add(item.id);
    commands.push(item as unknown as EditorCommandCapability);
  }
  const sectionIds = new Set<string>();
  const contextSections: EditorContextSection[] = [];
  for (const item of value.contextSections) {
    if (!exactKeys(item, ['id', 'label'])
      || typeof item.id !== 'string' || !CONTEXT_RE.test(item.id)
      || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 100
      || sectionIds.has(item.id)) {
      throw new Error('Неверное объявление секции контекста');
    }
    sectionIds.add(item.id);
    contextSections.push(item as unknown as EditorContextSection);
  }
  return { commands, contextSections };
}

/**
 * Значение присваивания карты триажа — литерал в кавычках, возможно в несколько строк:
 * так карту и пишут живые профили. Внутри двойных кавычек `$`, обратная кавычка и `\`
 * означали бы вычисление, поэтому отвергаются; после литерала — только комментарий.
 */
function triageLiteral(rest: string): string {
  const quote = rest[0];
  const end = quote === '"' || quote === '\'' ? rest.indexOf(quote, 1) : -1;
  const value = end > 0 ? rest.slice(1, end) : '';
  const tail = end > 0 ? rest.slice(end + 1).split(/\r?\n/, 1)[0] ?? '' : '';
  const literal = end > 0
    && !(quote === '"' && /[$`\\]/.test(value))
    && /^[ \t]*(?:#.*)?$/.test(tail);

  if (!literal) {
    throw new Error('Карта триажа не является literal metadata');
  }

  return value;
}

/**
 * Вытаскивает только literal assignment карты триажа из profile.sh как metadata.
 * Неизвестное shell-выражение не вычисляется и блокирует допуск публикации.
 */
async function staticTriageRoutes(file: string): Promise<string[]> {
  let info;
  try {
    info = await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) {
    throw new Error('Профильная карта триажа недоступна');
  }
  const source = await fs.readFile(file, 'utf8');
  const assignments = [...source.matchAll(/^[ \t]*(?:export[ \t]+)?PROFILE_TRIAGE_ROUTES[ \t]*=/gm)];
  if (assignments.length === 0) return [];
  if (assignments.length !== 1) throw new Error('Карта триажа неоднозначна');
  const [assignment] = assignments;
  // Пробел перед `=` делает строку командой shell, а не присваиванием.
  if (!assignment || !assignment[0].endsWith('PROFILE_TRIAGE_ROUTES=')) {
    throw new Error('Карта триажа не является literal metadata');
  }
  const raw = triageLiteral(source.slice(assignment.index + assignment[0].length));
  return [...new Set(parseRouteMap(raw).byKey.values())].sort();
}

/**
 * Только metadata: не запускает профиль, не раскрывает runners.env или prompts.
 */
export async function readEditorCapabilities(
  profile: string,
  { profilesDir }: { profilesDir: string },
): Promise<EditorCapabilitiesSnapshot> {
  assertProfileId(profile);
  const builtins = await engineBuiltins(profile);
  const issues: RouteEditorIssue[] = [];
  const profileDir = path.join(profilesDir, profile);
  const graph = path.join(profileDir, 'graph.json');
  let profileAvailable = false;
  try {
    const [directoryInfo, graphInfo] = await Promise.all([fs.lstat(profileDir), fs.lstat(graph)]);
    profileAvailable = directoryInfo.isDirectory() && !directoryInfo.isSymbolicLink()
      && graphInfo.isFile() && !graphInfo.isSymbolicLink();
  } catch {
    profileAvailable = false;
  }
  if (!profileAvailable) {
    issues.push(profileIssue('profileUnavailable',
      'Фабричный профиль проекта недоступен для публикации.'));
  }

  let manifest: Awaited<ReturnType<typeof readManifest>> = null;
  let externalRouteIds: string[] = [];
  if (profileAvailable) {
    try {
      const routesDir = path.join(profileDir, 'routes');
      const routesInfo = await fs.lstat(routesDir).catch(() => null);
      if (routesInfo?.isSymbolicLink() || (routesInfo && !routesInfo.isDirectory())) {
        throw new Error('Каталог routes подменён');
      }
      manifest = await readManifest(path.join(routesDir, 'editor-capabilities.json'));
    } catch {
      issues.push(profileIssue('capabilities_invalid',
        'Декларация возможностей профиля повреждена.', '/capabilities'));
    }
  }
  const builtInIds = new Set(builtins.contextSections.map((item) => item.id));
  if (manifest?.contextSections.some((item) => builtInIds.has(item.id))) {
    issues.push(profileIssue('capabilities_invalid',
      'Секция профиля совпадает со встроенной секцией.', '/capabilities/contextSections'));
  }
  const capabilities: EditorCapabilities = {
    schema: 1,
    commands: manifest?.commands ?? [],
    contextSections: [
      ...builtins.contextSections,
      ...manifest?.contextSections.filter((item) => !builtInIds.has(item.id)) ?? [],
    ],
    filesystem: builtins.filesystem,
    timeoutClasses: builtins.timeoutClasses,
    retryStrategies: builtins.retryStrategies,
  };
  if (profileAvailable) {
    try {
      externalRouteIds = await staticTriageRoutes(path.join(profileDir, 'profile.sh'));
    } catch {
      issues.push(profileIssue('triage_metadata_unavailable',
        'Карту маршрутов триажа нельзя проверить без исполнения профиля.',
        '/profile/triageRoutes'));
    }
  }
  const runners = loadRunnerConfig(profilesDir, profile);
  const runnerChain = [
    runners.PROJECT_RUNNER_PRIMARY,
    ...String(runners.PROJECT_RUNNER_FAILOVER ?? '').split(','),
  ].map((item) => String(item ?? '').trim()).filter(Boolean);
  const metadata = {
    coverage: runners.RUNNERS_COVERAGE ?? null,
    primary: runners.PROJECT_RUNNER_PRIMARY ?? null,
    failover: runners.PROJECT_RUNNER_FAILOVER ?? null,
  };
  const capabilitiesHash = profileAvailable && issues.length === 0
    ? createHash('sha256').update(JSON.stringify(stable({
      version: 'routes-editor-capabilities-v2',
      manifest,
      capabilities,
      metadata,
      externalRouteIds,
      nativeFanoutRunners: builtins.nativeFanoutRunners,
    }))).digest('hex') : null;
  return {
    capabilities,
    capabilitiesHash,
    issues,
    profileAvailable,
    externalRouteIds,
    nativeFanoutRunners: builtins.nativeFanoutRunners,
    runnerChain,
  };
}

/** Проверяет заявленные возможности для каждого узла каталога и bootstrap. */
export function validateDraftCapabilities(
  draft: RouteDraft,
  snapshot: EditorCapabilitiesSnapshot,
): RouteEditorIssue[] {
  const issues = [...snapshot.issues];
  const commands = new Map(snapshot.capabilities.commands.map((item) => [item.id, item]));
  const sections = new Set(snapshot.capabilities.contextSections.map((item) => item.id));
  const nativeFanoutAvailable = snapshot.runnerChain.some((runner) => (
    snapshot.nativeFanoutRunners.includes(runner)
  ));
  const machines = [
    ...Object.entries(draft.routes).map(([routeId, bundle]) => ({
      machine: bundle.route,
      scope: 'route' as const,
      routeId,
      base: `/routes/${routeId}/route`,
    })),
    { machine: draft.bootstrap, scope: 'bootstrap' as const, routeId: null, base: '/bootstrap' },
  ];
  for (const { machine, scope, routeId, base } of machines) {
    for (const [index, node] of machine.nodes.entries()) {
      if (node.fanout?.mode === 'parallel' && node.fanout.degrade === 'forbid'
        && !nativeFanoutAvailable) {
        issues.push({
          code: 'fanout_capability_unavailable',
          severity: 'error',
          scope,
          routeId,
          nodeId: node.id,
          path: `${base}/nodes/${index}/fanout`,
          message: 'Ни один runner политики не заявляет native fanout.',
        });
      }
      const command = node.executor === 'command' ? commands.get(node.commandId ?? '') : null;
      if (node.executor === 'command' && !command) {
        issues.push({
          code: 'command_unavailable',
          severity: 'error',
          scope,
          routeId,
          nodeId: node.id,
          path: `${base}/nodes/${index}/commandId`,
          message: 'Команда не объявлена возможностями профиля.',
        });
      }
      if (command && node.policy?.filesystem
        && !command.filesystem.includes(node.policy.filesystem)) {
        issues.push({
          code: 'command_filesystem_unavailable',
          severity: 'error',
          scope,
          routeId,
          nodeId: node.id,
          path: `${base}/nodes/${index}/policy/filesystem`,
          message: 'Политика записи команды не объявлена возможностями профиля.',
        });
      }
      if (node.executor === 'agent') {
        for (const [contextIndex, section] of (node.prompt?.requiredContext ?? []).entries()) {
          if (!sections.has(section)) {
            issues.push({
              code: 'context_section_unavailable',
              severity: 'error',
              scope,
              routeId,
              nodeId: node.id,
              path: `${base}/nodes/${index}/prompt/requiredContext/${contextIndex}`,
              message: 'Секция контекста не объявлена движком или профилем.',
            });
          }
        }
      }
    }
  }
  for (const routeId of snapshot.externalRouteIds) {
    if (!Object.hasOwn(draft.routes, routeId)) {
      issues.push({
        code: 'external_route_dependency',
        severity: 'error',
        scope: 'catalog',
        routeId,
        nodeId: null,
        path: `/routes/${routeId}`,
        message: 'Маршрут ещё используется декларативной картой триажа профиля.',
      });
    }
  }
  return issues;
}
