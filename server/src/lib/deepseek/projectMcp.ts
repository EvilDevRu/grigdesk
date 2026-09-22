import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Проектные MCP-серверы для DeepSeek из `.mcp.json` у корня проекта.
 *
 * Claude и Kimi читают этот файл сами, Codex — свой `.codex/config.toml`. DSH же получает
 * список серверов только через ACP `session/new`/`session/resume`, и до этой правки в него
 * попадал лишь служебный `cockpit-work`. Здесь та же схема файла (`{ mcpServers: { name:
 * { command, args, env } } }`), но только stdio: DSH требует абсолютную command, поэтому
 * относительная команда разрешается по PATH сервера, а запись без исполняемого файла
 * пропускается с предупреждением, а не роняет ход.
 */

export interface ProjectMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export interface ProjectMcpRead {
  file: string | null;
  servers: ProjectMcpServer[];
  warnings: string[];
}

// Имя внутреннего сервера Cockpit нельзя перекрыть проектным файлом.
const RESERVED_NAMES = new Set(['cockpit-work', 'cockpit-perm']);

/** Ближайший каталог с `.git` вверх от cwd; без репозитория корнем считается сам cwd. */
export async function nearestProjectRoot(cwd: string): Promise<string> {
  let current = path.resolve(cwd);
  while (true) {
    try {
      await fs.access(path.join(current, '.git'));
      return current;
    } catch { /* поднимаемся к родителю */ }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await fs.access(file, fs.constants.X_OK);
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Абсолютный путь команды: как задано либо первый исполняемый файл по PATH. */
export async function resolveCommand(
  command: string,
  searchPath: string = process.env.PATH || '',
): Promise<string | null> {
  if (path.isAbsolute(command)) return (await isExecutable(command)) ? command : null;
  if (command.includes('/')) return null;
  for (const dir of searchPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, command);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

function envEntries(value: unknown, name: string, warnings: string[]): Array<{ name: string; value: string }> | null {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    warnings.push(`${name}: env должен быть объектом`);
    return null;
  }
  const entries: Array<{ name: string; value: string }> = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!key || key.includes('=') || key.includes('\0') || typeof raw !== 'string' || raw.includes('\0')) {
      warnings.push(`${name}: переменная ${key} задана некорректно`);
      return null;
    }
    entries.push({ name: key, value: raw });
  }
  return entries;
}

/**
 * Разбор содержимого `.mcp.json`. Файл недоверенный: каждая запись проверяется по форме,
 * плохие записи не отменяют хорошие. `searchPath` подменяется в тестах.
 */
export async function parseProjectMcpServers(
  value: unknown,
  { searchPath }: { searchPath?: string } = {},
): Promise<{ servers: ProjectMcpServer[]; warnings: string[] }> {
  const warnings: string[] = [];
  const servers: ProjectMcpServer[] = [];
  const entries = (value as { mcpServers?: unknown } | null)?.mcpServers;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    warnings.push('.mcp.json должен быть JSON-объектом');
    return { servers, warnings };
  }
  if (entries === undefined) return { servers, warnings };
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    warnings.push('.mcp.json: mcpServers должен быть объектом');
    return { servers, warnings };
  }

  for (const [rawName, entry] of Object.entries(entries as Record<string, unknown>)) {
    const name = String(rawName || '').trim();
    if (!name || RESERVED_NAMES.has(name)) {
      warnings.push(`${rawName}: имя пустое или зарезервировано Cockpit`);
      continue;
    }
    const record = entry as {
      command?: unknown; args?: unknown; env?: unknown; url?: unknown; type?: unknown;
      disabled?: unknown; enabled?: unknown;
    } | null;
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      warnings.push(`${name}: запись должна быть объектом`);
      continue;
    }
    if (record.disabled === true || record.enabled === false) continue;
    if (typeof record.url === 'string' || (record.type && record.type !== 'stdio')) {
      warnings.push(`${name}: DeepSeek V1 получает только stdio-серверы, запись пропущена`);
      continue;
    }
    const command = typeof record.command === 'string' ? record.command.trim() : '';
    if (!command) {
      warnings.push(`${name}: нет command`);
      continue;
    }
    const args = record.args === undefined ? [] : record.args;
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
      warnings.push(`${name}: args должен быть массивом строк`);
      continue;
    }
    const env = envEntries(record.env, name, warnings);
    if (env === null) continue;
    const resolved = await resolveCommand(command, searchPath);
    if (!resolved) {
      warnings.push(`${name}: исполняемый файл ${command} не найден (нужен абсолютный путь или PATH)`);
      continue;
    }
    servers.push({ name, command: resolved, args: [...args] as string[], env });
  }
  return { servers, warnings };
}

async function readMcpFile(
  file: string,
  options: { searchPath?: string },
): Promise<{ found: boolean; servers: ProjectMcpServer[]; warnings: string[] }> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') return { found: false, servers: [], warnings: [] };
    return { found: true, servers: [], warnings: [`${file} не прочитан: ${(error as Error).message}`] };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { found: true, servers: [], warnings: [`${file}: некорректный JSON (${(error as Error).message})`] };
  }
  const parsed = await parseProjectMcpServers(value, options);
  return { found: true, ...parsed };
}

/**
 * Читает `.mcp.json` у корня репозитория и в самом cwd хода (cwd перекрывает одноимённые
 * записи): проект без `.git` внутри чужого репозитория или рабочей папки всё равно получает
 * свои серверы. Отсутствие файлов — не ошибка; `file` — последний найденный слой.
 */
export async function readProjectMcpServers(
  cwd: string,
  options: { searchPath?: string } = {},
): Promise<ProjectMcpRead> {
  const root = await nearestProjectRoot(cwd);
  const layers = [path.join(root, '.mcp.json')];
  const local = path.join(path.resolve(cwd), '.mcp.json');
  if (local !== layers[0]) layers.push(local);

  const merged = new Map<string, ProjectMcpServer>();
  const warnings: string[] = [];
  let file: string | null = null;
  for (const layer of layers) {
    const read = await readMcpFile(layer, options);
    if (!read.found) continue;
    file = layer;
    warnings.push(...read.warnings);
    for (const server of read.servers) merged.set(server.name, server);
  }
  return { file, servers: [...merged.values()], warnings };
}

/**
 * Служебные серверы Cockpit идут первыми и выигрывают у одноимённых проектных;
 * проектные дубликаты по имени тоже не пропускаются — DSH отвергает повтор имени.
 */
export function mergeMcpServers(
  base: readonly ProjectMcpServer[],
  project: readonly ProjectMcpServer[],
): ProjectMcpServer[] {
  const seen = new Set(base.map((server) => server.name));
  const merged = [...base];
  for (const server of project) {
    if (seen.has(server.name)) continue;
    seen.add(server.name);
    merged.push(server);
  }
  return merged;
}
