export const VOICE_PACES = ['slowest', 'slow', 'normal', 'fast', 'fastest'] as const;
export const QWEN_SERVICES = ['model-studio', 'qwencloud-token'] as const;

export type QwenService = typeof QWEN_SERVICES[number];

export type VoiceCommand =
  | 'help'
  | 'version'
  | 'engines'
  | 'models'
  | 'voices'
  | 'generate'
  | 'install';

export interface GenerateArgs {
  command: 'generate';
  engine: string | null;
  voice: string | null;
  text: string | null;
  file: string | null;
  out: string | null;
  format: string | null;
  instruction: string | null;
  language: string | null;
  service: string | null;
  pace: string | null;
  apiKey: string | null;
  dir: string | null;
  json: boolean;
}

export interface SimpleArgs {
  service: string | null;
  command: 'help' | 'version' | 'engines' | 'models';
  engine: null;
  apiKey: string | null;
  dir: string | null;
  json: boolean;
}

export interface VoicesArgs {
  service: string | null;
  command: 'voices';
  engine: string | null;
  apiKey: string | null;
  dir: string | null;
  json: boolean;
}

export interface InstallArgs {
  service: string | null;
  command: 'install';
  engine: string;
  apiKey: string | null;
  dir: string | null;
  json: boolean;
}

export type ParsedArgs =
  | GenerateArgs
  | SimpleArgs
  | VoicesArgs
  | InstallArgs
  | { error: string };

type SuccessfulArgs = Exclude<ParsedArgs, { error: string }>;

const COMMANDS: readonly string[] = [
  'help', 'version', 'engines', 'models', 'voices', 'generate', 'install',
];
const COMMON_FLAGS = ['--api-key', '--dir', '--json', '--service'];
const GENERATE_FLAGS = [
  '--engine', '--voice', '--text', '--file', '--out', '--format', '--pace', '--instruction', '--language',
];
const ENGINES = ['qwen', 'piper', 'silero'];

export const HELP_TEXT = `voice — синтез речи в WAV

Команды:
  voice engines [--json]                  Движки, готовность и причины отказа
  voice models [--json]                   Модели, языки и возможности
  voice voices [--engine ID] [--json]     Голоса выбранного движка или всех движков
  voice generate --text ТЕКСТ [опции]     Создать WAV из строки
  voice generate --file ФАЙЛ [опции]      Создать WAV из файла UTF-8
  voice install piper|silero [--json]     Установить локальный движок и модель
  voice version                          Версия программы
  voice help                             Эта справка

Опции генерации:
  --engine qwen|piper|silero
  --voice ИМЯ       По умолчанию: Cherry / longanhuan_v3.6 / irina / xenia
  --language КОД   Язык; Token Plan учитывает текст и выбранный голос, Model Studio — Auto
  --out ФАЙЛ        По умолчанию: ./voice-<UTC-метка>-<UUID>.wav
  --format wav      Единственный формат v1; MP3 и перекодирования нет
  --pace slowest|slow|normal|fast|fastest
  --instruction ТЕКСТ   Применяется в QwenCloud Token Plan; у остальных — ignoredDirections

Общие опции: --dir КАТАЛОГ, --api-key КЛЮЧ, --json, --service СЕРВИС.
Сервис: --service → GRIGDESK_VOICE_QWEN_SERVICE → model-studio.
  model-studio — обычный Model Studio API, qwen3-tts-flash, 48 голосов.
  qwencloud-token — подписка QwenCloud Token Plan, qwen-audio-3.0-tts-plus, один проверенный голос.
Сервис нельзя определить по префиксу ключа: sk-sp- бывает у разных подписок.
Ключ: --api-key → GRIGDESK_VOICE_QWEN_API_KEY → DASHSCOPE_API_KEY.
В qwencloud-token перед DASHSCOPE_API_KEY также проверяется TOKEN_PLAN_API_KEY.
--api-key виден в списке процессов; надёжнее переменная окружения.
Файловые хранилища ключей сервера команда не читает.
Каталог: --dir → GRIGDESK_VOICE_DIR → ~/.grigdesk/voice.
Адрес Qwen можно задать через GRIGDESK_VOICE_QWEN_BASE_URL.

Без --engine выбирается первый готовый: Qwen → Piper → Silero.
При наличии ключа текст уйдёт в платное облако. Для локальной речи укажите --engine.
После отказа синтеза другой движок автоматически не вызывается.
Лимит канонического текста: Model Studio 600 символов, Token Plan/Piper/Silero 2000.
Ударения: з+амок, зам+ок. Silero применяет их. Token Plan принимает также за́мок/замо́к,
передаёт метки с инструкцией и предупреждает: произношение экспериментальное, нужно прослушивание.
Model Studio сообщает об игнорировании +. Инструкция Token Plan с общей подсказкой — до 1600 символов.
Темп применяют Token Plan, Piper и Silero. Silero требует цифры и латиницу русскими словами.
generate всегда печатает одну строку JSON; прогресс и ошибки идут в stderr.
Коды выхода: 0 — успех, 2 — аргументы, 1 — выполнение.

Примеры:
  voice install piper
  voice generate --engine piper --text "Проверка связи" --out speech.wav
  voice generate --engine silero --voice xenia --text "з+амок" --pace slow
  voice generate --service qwencloud-token --engine qwen --text "Я плач+у за билет" --out speech.wav
  voice voices --engine qwen --json
`;

/**
 * Ограничивает набор опций командой до чтения значений.
 * Неизвестные аргументы не отражаются в ошибке: ими может оказаться случайно переданный ключ.
 */
function flagsFor(command: VoiceCommand): Set<string> {
  const flags = new Set(COMMON_FLAGS);

  if (command === 'generate') {
    for (const flag of GENERATE_FLAGS) {
      flags.add(flag);
    }
  } else if (command === 'voices') {
    flags.add('--engine');
  }

  return flags;
}

/**
 * Превращает проверенный набор флагов в прежний дискриминированный ParsedArgs.
 * Отсутствующее значение остаётся null; пустой текст проверяется до синтеза.
 */
function assembleArgs(
  command: VoiceCommand,
  values: Map<string, string>,
  positional: string[],
  json: boolean,
): SuccessfulArgs | { error: string } {
  const common = {
    service: values.get('--service') ?? null,
    apiKey: values.get('--api-key') ?? null,
    dir: values.get('--dir') ?? null,
    json,
  };

  if (command === 'install') {
    const engine = positional[0];

    if (positional.length !== 1 || (engine !== 'piper' && engine !== 'silero')) {
      return { error: 'install требует ровно один движок: piper или silero' };
    }

    return {
      command,
      engine,
      ...common,
    };
  }

  if (positional.length > 0) {
    return { error: 'лишний позиционный аргумент' };
  }

  const engine = values.get('--engine') ?? null;

  if (engine !== null && !ENGINES.includes(engine)) {
    return { error: 'неизвестный движок; допустимы qwen, piper, silero' };
  }

  if (command === 'generate') {
    const text = values.get('--text') ?? null;
    const file = values.get('--file') ?? null;
    const pace = values.get('--pace') ?? null;
    const format = values.get('--format') ?? null;

    if (text === null && file === null) {
      return { error: 'generate требует --text или --file' };
    }

    if (text !== null && file !== null) {
      return { error: 'укажите либо --text, либо --file' };
    }

    if (pace !== null && !VOICE_PACES.some((value) => value === pace)) {
      return { error: 'неизвестный темп; допустимы slowest, slow, normal, fast, fastest' };
    }

    if (format !== null && format !== 'wav') {
      return { error: 'неподдержанный формат; в v1 доступен только wav' };
    }

    return {
      command,
      engine,
      voice: values.get('--voice') ?? null,
      text,
      file,
      out: values.get('--out') ?? null,
      format,
      instruction: values.get('--instruction') ?? null,
      language: values.get('--language') ?? null,
      pace,
      ...common,
    };
  }

  if (command === 'voices') {
    return {
      command,
      engine,
      ...common,
    };
  }

  return {
    command,
    engine: null,
    ...common,
  };
}

/**
 * Разбирает CLI без файлов, процессов и сети; все отказы аргументов возвращает данными.
 * Повтор флага и пропущенное значение не подменяются последующим аргументом молча.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const first = argv[0] ?? 'help';
  const normalized = first === '--help' || first === '-h' ? 'help' : first;

  if (!COMMANDS.includes(normalized)) {
    return { error: 'неизвестная команда; выполните voice help' };
  }

  const command = normalized as VoiceCommand;
  const allowed = flagsFor(command);
  const seen = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];
  let json = false;

  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];

    if (flag === undefined) {
      return { error: 'неполный список аргументов' };
    }

    if (!flag.startsWith('-')) {
      positional.push(flag);

      continue;
    }

    if (!allowed.has(flag)) {
      return { error: 'неизвестный флаг для этой команды' };
    }

    if (seen.has(flag)) {
      return { error: `повтор флага ${flag}` };
    }

    seen.add(flag);

    if (flag === '--json') {
      json = true;

      continue;
    }

    const value = argv[index + 1];

    if (value === undefined || value.startsWith('--')) {
      return { error: `после ${flag} нужно значение` };
    }

    if (value.trim() === '' && flag !== '--text' && flag !== '--instruction') {
      return { error: `значение ${flag} не может быть пустым` };
    }

    values.set(flag, value);
    index += 1;
  }

  return assembleArgs(command, values, positional, json);
}
