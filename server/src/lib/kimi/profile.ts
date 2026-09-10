import { promises as fs } from 'node:fs';
import path from 'node:path';

export const KIMI_AUTH_PROFILE_ID = 'kimi-code-oauth';
export const KIMI_SECURITY_PROFILE = 'kimi-contained-v1';
// Host-режим (kimiLaunchMode=host): прямой хост-процесс без namespace/cgroup/egress
// allowlist. Отдельный profile id, потому что session bindings пинятся к профилю:
// contained-сессии жили в per-chat runtime home и host-процессу недоступны, а значит
// при смене режима binding обязан ротироваться, а не молча резюмить чужое состояние.
export const KIMI_HOST_SECURITY_PROFILE = 'kimi-host-v1';

export function kimiSecurityProfile(config: { kimiLaunchMode?: unknown } | null | undefined): string {
  return config?.kimiLaunchMode === 'host' ? KIMI_HOST_SECURITY_PROFILE : KIMI_SECURITY_PROFILE;
}

// Каталог намеренно version-pinned к проверенному ACP runtime 0.31.1. Новые модели
// добавляются только после обновления contract fixtures, а не молча из host config.
// Так Kimi внутри sandbox не видит пользовательские provider-ы, API keys, hooks и MCP.
export const KIMI_MODELS = Object.freeze([
  Object.freeze({
    id: 'kimi-code/k3',
    wireModel: 'k3',
    name: 'K3',
    context: 1_048_576,
    tier: 100,
    efforts: Object.freeze(['low', 'high', 'max']),
    defaultEffort: 'high',
    capabilities: Object.freeze(['thinking', 'always_thinking', 'image_in', 'video_in', 'tool_use']),
  }),
  Object.freeze({
    id: 'kimi-code/k3-256k',
    wireModel: 'k3-256k',
    name: 'K3-256k',
    context: 262_144,
    tier: 90,
    efforts: Object.freeze(['low', 'high', 'max']),
    defaultEffort: 'high',
    capabilities: Object.freeze(['thinking', 'always_thinking', 'image_in', 'tool_use']),
  }),
  Object.freeze({
    id: 'kimi-code/kimi-for-coding-highspeed',
    wireModel: 'kimi-for-coding-highspeed',
    name: 'K2.7 Coding Highspeed',
    context: 262_144,
    tier: 80,
    efforts: Object.freeze([]),
    capabilities: Object.freeze(['thinking', 'always_thinking', 'image_in', 'video_in', 'tool_use']),
  }),
  Object.freeze({
    id: 'kimi-code/kimi-for-coding',
    wireModel: 'kimi-for-coding',
    name: 'K2.7 Coding',
    context: 262_144,
    tier: 70,
    efforts: Object.freeze([]),
    capabilities: Object.freeze(['thinking', 'always_thinking', 'image_in', 'video_in', 'tool_use']),
  }),
]);

function tomlString(value: unknown): string {
  return JSON.stringify(String(value));
}

function tomlArray(values: readonly unknown[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

/**
 * Cockpit-owned минимальный config: только managed Kimi OAuth и проверенный каталог.
 * Ни один байт host config.toml сюда не переносится.
 */
export function buildContainedKimiConfig(): string {
  const lines = [
    '# Сгенерировано Cockpit. Host config/hooks/plugins/MCP сюда не импортируются.',
    `default_model = ${tomlString(KIMI_MODELS[0]?.id)}`,
    'default_permission_mode = "manual"',
    'default_plan_mode = false',
    'merge_all_available_skills = false',
    'extra_skill_dirs = []',
    'extra_agent_dirs = []',
    'telemetry = false',
    '',
    '[providers."managed:kimi-code"]',
    'type = "kimi"',
    'base_url = "https://api.kimi.com/coding/v1"',
    'api_key = ""',
    'oauth = { storage = "file", key = "oauth/kimi-code", oauth_host = "https://auth.kimi.com" }',
    '',
  ];
  for (const model of KIMI_MODELS) {
    lines.push(
      `[models.${tomlString(model.id)}]`,
      'provider = "managed:kimi-code"',
      `model = ${tomlString(model.wireModel)}`,
      `max_context_size = ${model.context}`,
      `capabilities = ${tomlArray(model.capabilities)}`,
      `display_name = ${tomlString(model.name)}`,
    );
    if (model.efforts.length) {
      lines.push(
        `support_efforts = ${tomlArray(model.efforts)}`,
        `default_effort = ${tomlString((model as { defaultEffort?: string }).defaultEffort)}`,
      );
    }
    lines.push('');
  }
  lines.push(
    '[thinking]',
    'enabled = true',
    'effort = "high"',
    '',
    '[permission]',
    'mode = "manual"',
    '',
    '[background]',
    'max_running_tasks = 1',
    'keep_alive_on_exit = false',
    'bash_auto_background_on_timeout = false',
    'kill_grace_period_ms = 1000',
    '',
    '[model_catalog]',
    'refresh_interval_ms = 0',
    'refresh_on_start = false',
    '',
    '[services.moonshot_search]',
    'base_url = "https://api.kimi.com/coding/v1/search"',
    'api_key = ""',
    'oauth = { storage = "file", key = "oauth/kimi-code", oauth_host = "https://auth.kimi.com" }',
    '',
    '[services.moonshot_fetch]',
    'base_url = "https://api.kimi.com/coding/v1/fetch"',
    'api_key = ""',
    'oauth = { storage = "file", key = "oauth/kimi-code", oauth_host = "https://auth.kimi.com" }',
    '',
  );
  return `${lines.join('\n')}\n`;
}

async function atomicWrite(file: string, content: string, mode = 0o600): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, content, { mode });
  await fs.rename(temp, file);
  await fs.chmod(file, mode).catch(() => {});
}

/** Создаёт только server-owned runtime state; credential-файл не читает и не копирует. */
export async function ensureContainedKimiHome(
  runtimeHome: string,
  { trustedHome = runtimeHome }: { trustedHome?: string } = {},
): Promise<{
  runtimeHome: string;
  trustedHome: string;
  configPath: string;
  emptyFile: string;
  emptyMcp: string;
}> {
  if (!path.isAbsolute(runtimeHome || '')) throw new TypeError('kimi runtime home должен быть абсолютным');
  if (!path.isAbsolute(trustedHome || '')) throw new TypeError('kimi trusted home должен быть абсолютным');
  await fs.mkdir(runtimeHome, { recursive: true, mode: 0o700 });
  await fs.mkdir(trustedHome, { recursive: true, mode: 0o700 });
  await fs.chmod(runtimeHome, 0o700).catch(() => {});
  await fs.chmod(trustedHome, 0o700).catch(() => {});
  for (const dir of ['sessions', 'credentials', 'volatile']) {
    const target = path.join(runtimeHome, dir);
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    await fs.chmod(target, 0o700).catch(() => {});
  }
  for (const dir of ['empty/plugins', 'empty/skills', 'empty/agents']) {
    const target = path.join(trustedHome, dir);
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    await fs.chmod(target, 0o700).catch(() => {});
  }
  const configPath = path.join(runtimeHome, 'config.toml');
  const wanted = buildContainedKimiConfig();
  let current = '';
  try { current = await fs.readFile(configPath, 'utf8'); } catch { /* первый запуск */ }
  if (current !== wanted) await atomicWrite(configPath, wanted);

  // Пустые файлы перекрывают автозагружаемые источники. Они server-owned и не
  // меняются процессом Kimi, потому что в sandbox bind-mounted read-only.
  const emptyFile = path.join(trustedHome, 'empty', 'EMPTY');
  const emptyMcp = path.join(trustedHome, 'empty', 'mcp.json');
  await fs.mkdir(path.dirname(emptyFile), { recursive: true, mode: 0o700 });
  const ensureExact = async (file: string, content: string) => {
    let currentContent: string | null = null;
    try { currentContent = await fs.readFile(file, 'utf8'); } catch { /* первый запуск */ }
    if (currentContent !== content) await atomicWrite(file, content, 0o400);
  };
  await Promise.all([
    ensureExact(emptyFile, ''),
    ensureExact(emptyMcp, '{}\n'),
  ]);
  await Promise.all([emptyFile, emptyMcp, configPath].map((file) => fs.chmod(file, 0o400).catch(() => {})));
  return { runtimeHome, trustedHome, configPath, emptyFile, emptyMcp };
}

export function kimiSeedModels() {
  return KIMI_MODELS.map((model) => ({
    id: model.id,
    family: model.wireModel,
    name: model.name,
    context: model.context,
    tier: model.tier,
    efforts: [...model.efforts],
  }));
}
