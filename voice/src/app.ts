import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { HELP_TEXT, parseArgs } from './args.ts';
import type { GenerateArgs, ParsedArgs } from './args.ts';
import { redactSecrets, resolveVoiceConfig } from './config.ts';
import type { VoiceConfig, VoiceEnv } from './config.ts';
import { VoiceError } from './contract.ts';
import type { VoiceDoctor, VoiceEngine, VoiceInfo, VoicePace } from './contract.ts';
import { installCommand } from './local/installCommand.ts';
import type { LocalPackage } from './local/catalogs.ts';
import type { RunProcess } from './process.ts';
import { buildEngines } from './registry.ts';

export interface RuntimeInfo {
  version: string;
}

export interface VoiceIO {
  env: VoiceEnv;
  getHome(): string;
  readText(file: string): Promise<string | null>;
  readFile(file: string): Promise<string | Uint8Array>;
  writeFile(file: string, value: string | Uint8Array): Promise<void>;
  writeStdout(value: string | Uint8Array): Promise<void>;
  writeStderr(value: string): Promise<void>;
  fetch: typeof fetch;
  spawn: RunProcess;
  scriptPath(name: string): Promise<string>;
  buildEngines?: (config: VoiceConfig, io: VoiceIO) => VoiceEngine[];
  signal?: AbortSignal;
  localPackages?: readonly LocalPackage[];
  bootstrapPython?: string;
  installTimeoutMs?: number;
  installCommandTimeoutMs?: number;
  downloadTimeoutMs?: number;
}

type CommandArgs = Exclude<ParsedArgs, { error: string }>;

/**
 * Версия описывает исполняемый процесс и не требует конфигурации или сети.
 * Её проверяет сборщик SEA в пустом окружении.
 */
export function versionLine(version: string): string {
  return `voice ${version} (Node ${process.version}, ${process.platform} ${process.arch})\n`;
}

/**
 * Сохраняет код отказа даже после закрытия stderr вызывающей программой.
 * В сообщение не добавляет исходное исключение или диагностические свойства транспорта.
 */
async function fail(io: VoiceIO, message: string, code: number): Promise<number> {
  try {
    await io.writeStderr(`${message}\n`);
  } catch {
    // Вызывающий всё равно получит ненулевой код, даже когда поток уже закрыт.
  }

  return code;
}

/**
 * Явный движок выбирается без doctor: адаптер сначала проверит голос и формат.
 * Автовыбор проверяет готовность по порядку и не повторяется после отказа синтеза.
 */
async function selectEngine(engines: readonly VoiceEngine[], requested: string | null): Promise<VoiceEngine> {
  if (requested !== null) {
    const selected = engines.find((engine) => engine.id === requested);

    if (!selected) {
      throw new VoiceError('Неизвестный движок.', 2);
    }

    return selected;
  }

  for (const engine of engines) {
    const doctor = await engine.doctor();

    if (doctor.status === 'ready') {
      return engine;
    }
  }

  throw new VoiceError(
    'нет готового движка: задайте ключ Qwen (GRIGDESK_VOICE_QWEN_API_KEY) '
      + 'или установите локальный (voice install piper)',
  );
}

/**
 * Читает ровно указанный файл через внедрённый порт и проверяет UTF-8 строго.
 * Невозможность чтения не раскрывает сырой системный error или содержимое файла.
 */
async function generationText(args: GenerateArgs, io: VoiceIO): Promise<string> {
  if (args.text !== null) {
    return args.text;
  }

  if (args.file === null) {
    throw new VoiceError('generate требует --text или --file.', 2);
  }

  let contents: string | Uint8Array;

  try {
    contents = await io.readFile(args.file);
  } catch {
    throw new VoiceError('Не удалось прочитать файл текста.');
  }

  if (typeof contents === 'string') {
    return contents;
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(contents);
  } catch {
    throw new VoiceError('Файл текста должен содержать корректный UTF-8.', 2);
  }
}

/**
 * Возвращает один JSON-отчёт только после завершения синтеза выбранным адаптером.
 * Default голоса принадлежит адаптеру; CLI не подменяет неизвестный голос другим.
 */
async function generate(
  args: GenerateArgs,
  engines: readonly VoiceEngine[],
  io: VoiceIO,
): Promise<string> {
  const text = await generationText(args, io);

  if (!text.trim()) {
    throw new VoiceError('Пустой текст для синтеза.', 2);
  }

  const engine = await selectEngine(engines, args.engine);
  const voice = args.voice ?? engine.defaultVoice;
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const outputFile = path.resolve(args.out ?? `voice-${stamp}-${randomUUID()}.wav`);
  const result = await engine.synthesize(
    {
      text,
      voiceRef: voice,
      language: args.language,
    },
    {
      outputFile,
      format: args.format ?? 'wav',
      pace: (args.pace as VoicePace | null) ?? 'normal',
      instruction: args.instruction,
      signal: io.signal,
    },
  );

  return `${JSON.stringify({
    engine: engine.id,
    model: engine.model,
    service: engine.service ?? null,
    voice,
    file: result.file,
    bytes: result.bytes,
    format: result.format,
    ignoredDirections: result.ignoredDirections,
    warnings: result.warnings ?? [],
  })}\n`;
}

/**
 * Показывает состояния всех движков, сохраняя причину и инструкцию восстановления.
 * JSON и обычный вывод строятся из одного результата doctor.
 */
async function engineList(engines: readonly VoiceEngine[], json: boolean): Promise<string> {
  const rows: Array<Pick<VoiceEngine, 'id' | 'name' | 'kind' | 'model' | 'service'> & VoiceDoctor> = [];

  for (const engine of engines) {
    const doctor = await engine.doctor();

    rows.push({
      id: engine.id,
      name: engine.name,
      kind: engine.kind,
      model: engine.model,
      service: engine.service,
      status: doctor.status,
      reason: doctor.reason,
      install: doctor.install,
    });
  }

  if (json) {
    return `${JSON.stringify(rows)}\n`;
  }

  return `${rows.map((row) => (
    `${row.id} — ${row.name} (${row.model}) — ${row.status} — ${row.reason}`
      + (row.install ? `; ${row.install}` : '')
  )).join('\n')}\n`;
}

/**
 * Каталог моделей описывает возможности независимо от текущего состояния установки.
 * Просмотр моделей не запускает платную пробу облака или локальный синтез.
 */
function modelList(engines: readonly VoiceEngine[], json: boolean): string {
  const rows = engines.map((engine) => ({
    id: engine.id,
    model: engine.model,
    service: engine.service,
    capabilities: engine.capabilities(),
  }));

  if (json) {
    return `${JSON.stringify(rows)}\n`;
  }

  return `${rows.map((row) => {
    const own = row.capabilities;

    return `${row.id} — ${row.model}; языки: ${own.languages.join(', ')}; `
      + `темп: ${own.pace ? 'да' : 'нет'}; `
      + `ударения: ${own.stressMode ?? (own.stress ? 'да' : 'нет')}; `
      + `инструкция: ${own.instruction ? 'да' : 'нет'}; `
      + `лимит: ${own.maxChars}; форматы: ${own.formats.join(', ')}`;
  }).join('\n')}\n`;
}

/**
 * Без фильтра показывает голоса всех движков и помечает их владельца.
 * Пустой локальный список объясняется человеку; JSON пустого списка остаётся массивом.
 */
async function voiceList(
  engines: readonly VoiceEngine[],
  engineId: string | null,
  json: boolean,
): Promise<string> {
  const selected = engineId === null ? engines : engines.filter((engine) => engine.id === engineId);

  if (selected.length === 0) {
    throw new VoiceError('Неизвестный движок.', 2);
  }

  const rows: Array<VoiceInfo & { engine: string }> = [];

  for (const engine of selected) {
    for (const voice of await engine.voices()) {
      rows.push({ ...voice, engine: engine.id });
    }
  }

  if (json) {
    return `${JSON.stringify(rows)}\n`;
  }

  if (rows.length === 0) {
    return 'Голоса не установлены. Выполните voice install piper или voice install silero.\n';
  }

  return `${rows.map((voice) => (
    `${voice.engine}/${voice.id} — ${voice.name}; языки: ${voice.languages.join(', ')}; `
      + (voice.available ? 'доступен' : `недоступен: ${voice.reason}`)
  )).join('\n')}\n`;
}

/**
 * Разделяет установку и генерацию до создания реестра движков.
 * Списки и справка не выполняют установку или платный тестовый синтез.
 */
async function produce(args: CommandArgs, info: RuntimeInfo, io: VoiceIO): Promise<string> {
  if (args.command === 'help') {
    return HELP_TEXT;
  }

  if (args.command === 'version') {
    return versionLine(info.version);
  }

  const config = resolveVoiceConfig(args, io.env, io.getHome());

  if (args.command === 'install') {
    if (args.engine !== 'piper' && args.engine !== 'silero') {
      throw new VoiceError('install поддерживает только piper и silero.', 2);
    }

    const installed = await installCommand(args.engine, config, io);

    return args.json
      ? `${JSON.stringify(installed)}\n`
      : `Установлен ${installed.engineId}: ${installed.packageId}.\n`;
  }

  const engines = (io.buildEngines ?? buildEngines)(config, io);

  switch (args.command) {
    case 'engines':
      return await engineList(engines, args.json);
    case 'models':
      return modelList(engines, args.json);
    case 'voices':
      return await voiceList(engines, args.engine, args.json);
    case 'generate':
      return await generate(args, engines, io);
  }

  throw new VoiceError('Неизвестная команда.', 2);
}

/**
 * Выполняет одну CLI-команду и оставляет stdout пустым при отказе подготовки результата.
 * Неожиданная ошибка не раскрывает raw message; ожидаемая дополнительно очищается от ключей.
 */
export async function runVoice(argv: readonly string[], info: RuntimeInfo, io: VoiceIO): Promise<number> {
  const args = parseArgs(argv);

  if ('error' in args) {
    return await fail(io, args.error, 2);
  }

  const secrets = [
    args.apiKey, io.env.GRIGDESK_VOICE_QWEN_API_KEY, io.env.TOKEN_PLAN_API_KEY, io.env.DASHSCOPE_API_KEY,
  ];
  let output: string;

  try {
    output = await produce(args, info, io);
  } catch (error) {
    const message = error instanceof VoiceError ? error.message : 'Не удалось выполнить команду voice.';
    const code = error instanceof VoiceError ? error.exitCode : 1;

    return await fail(io, redactSecrets(message, secrets), code);
  }

  try {
    await io.writeStdout(output);
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'EPIPE') {
      return 0;
    }

    return await fail(io, 'Не удалось записать ответ voice.', 1);
  }

  return 0;
}
