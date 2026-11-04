// Живая проверка режима GLM до допуска (G12). Запускает человек, когда выбран режим, ключ
// режима лежит в окружении службы; отдельный DI-допуск разрешён только для обычного api.
// Скрипт не меняет GLM_ADMISSION, не печатает ключ, ограничивает число ходов
// сценарием и пишет очищенный отчёт в glm/G12/ папки артефактов.
//
// Запуск: node server/scripts/glmLiveSmoke.mts --mode api --confirm-live --binary <ELF> --cache-dir <cache>
// Файл .env папки данных скрипт читает сам и ставит выше унаследованного окружения: окно ключей пишет в .env,
// а оболочка из чата держит значения со старта сервера, которые `node --env-file` не перекрывает.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { artifactsPath, envFilePath } from '../../shared/runtime/dataHome.ts';
import { config as serviceConfig } from '../src/config.ts';
import { readEnvFile } from '../src/lib/envFile.ts';
import { createGlmAdapter } from '../src/lib/executors/glm.ts';
import type { GlmAdapterDeps } from '../src/lib/executors/glm.ts';
import { glmCompatibilityIdentity, parseGlmAccessMode } from '../src/lib/glm/contract.ts';
import type { GlmAccessMode } from '../src/lib/glm/contract.ts';
import { assertGlmGenerationAdmission, describeGlmGenerationAsync } from '../src/lib/glm/generation.ts';
import { glmAccessError } from '../src/lib/glm/env.ts';
import { resolveDeepSeekRuntimeAsync } from '../src/lib/deepseek/runtimeProcess.ts';
import chatModule from '../src/modules/chat/index.ts';
import {
  cleanGlmSmokeDiagnostic,
  glmSmokeSecrets,
  readGlmSmokeHttpErrors,
  writeGlmSmokeHttpObserver,
} from './glmSmokeDiagnostics.mts';

const requireServer = createRequire(new URL('../package.json', import.meta.url));
const Fastify = requireServer('fastify');

// Потолок ходов сценария: живая проверка не должна расходовать квоту сверх нужного.
export const GLM_SMOKE_MAX_TURNS = 8;

export interface GlmSmokeStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface GlmSmokeOptions {
  mode: GlmAccessMode;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  config: typeof serviceConfig;
  binary: string;
  cacheDir: string;
  model?: string;
  workRoot: string;
  // Только для проверки скрипта на стенде: адрес фейковой модели и сторож fetch (Р16).
  adapterDeps?: Partial<GlmAdapterDeps>;
}

/**
 * Значение флага командной строки; отсутствующее или следующий флаг — пустая строка.
 * Ключи и прочие секреты через argv скрипт не принимает.
 */
function shellArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : '';

  return value && !value.startsWith('--') ? value : '';
}

/**
 * Очищенный текст для отчёта: временные пути заменены, длина ограничена.
 * Известные секреты вырезаются до ограничения длины, включая ошибки провайдера.
 */
function clean(value: unknown, root: string, secrets: readonly string[]): string {
  return cleanGlmSmokeDiagnostic(value, secrets, [root, os.homedir()]).slice(0, 400);
}

/**
 * Ответ хода — слова модели, а не текст обрыва: чат отдаёт обрыв CLI (сеть, TLS) и ошибку
 * хода тем же полем reply, поэтому успех требует отсутствия признаков прерывания.
 */
function answered(status: number, body: Record<string, any>): boolean {
  if (status !== 200 || !body.reply) {
    return false;
  }

  return !body.deliveryFailure && !body.interruptedBy && !body.error && body.role !== 'error';
}

/**
 * Сценарий живой проверки через временный Fastify с модулем чата и DI-адаптером GLM:
 * ответ, маркерные чтение/правка/команда, размышление и инструмент, resume, отказ политики,
 * стоп во время approval, повтор принятого хода по turnId. Возвращает шаги отчёта.
 */
export async function runGlmLiveSmoke(options: GlmSmokeOptions) {
  if (options.mode !== 'api' && options.mode !== 'coding-plan') {
    throw glmAccessError('glm_mode_not_admitted', 'Живая проверка разрешает только известные режимы GLM.');
  }
  if (!path.isAbsolute(options.binary) || !path.isAbsolute(options.cacheDir)) {
    throw new TypeError('Smoke требует абсолютные --binary и --cache-dir');
  }

  const root = await fs.mkdtemp(path.join(options.workRoot, 'live-'));
  const secrets = glmSmokeSecrets(options.env);
  const project = path.join(root, 'project');
  const marker = `GLM-SMOKE-${randomUUID().slice(0, 8)}`;
  // Дешёвая flash-модель по умолчанию: живой допуск не зависит от модели, сценарий
  // проверяет конвейер; явный --model перекрывает выбор (например, флагман glm-5.3).
  const model = JSON.stringify(['zai', options.model ?? 'glm-5.3-flash']);
  const config = {
    ...options.config,
    deepseekRuntimeMode: 'binary' as const,
    deepseekBin: options.binary,
    deepseekBinOverride: undefined,
    deepseekCacheDir: options.cacheDir,
    rootDir: project,
    chatsDir: path.join(root, 'chats'),
    chatStoreLegacyPath: path.join(root, 'legacy.json'),
    chatBindingsDir: path.join(root, 'bindings'),
    glmRuntimeHome: path.join(root, 'glm-home'),
  };
  const runtime = await resolveDeepSeekRuntimeAsync(config);
  const generation = await describeGlmGenerationAsync(config, runtime);
  const compatibility = glmCompatibilityIdentity(generation.runtime, options.mode);
  const admission = [{ mode: options.mode, compatibility }];

  assertGlmGenerationAdmission(generation, options.mode, admission);

  const endpoint = options.adapterDeps?.modelEndpoint;
  const kind = endpoint && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(endpoint).hostname)
    ? 'loopback' : 'live';
  const observer = await writeGlmSmokeHttpObserver(
    root,
    endpoint,
    options.adapterDeps?.egressGuard,
  );
  const adapter = createGlmAdapter({
    ...options.adapterDeps,
    egressGuard: observer.plugin,
    env: { ...options.env, GRIGDESK_GLM_API_MODE: options.mode },
    admission,
  });
  const steps: GlmSmokeStep[] = [];
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const app = Fastify({ logger: false });
  let turns = 0;

  await fs.mkdir(path.join(project, '.git'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(project, 'marker.txt'), `${marker}\n`);
  app.decorate('sse', {
    broadcast: (event: string, data: Record<string, unknown>) => events.push({ event, data }),
  });
  await app.register(chatModule, {
    config,
    factoryState: { readEnv: async () => ({}) },
    prefs: { read: () => ({ providerSettings: {} }) },
    claudeAuth: null,
    internalToken: randomUUID(),
    modelsRegistry: async () => ({ glm: [{ id: model, efforts: [] }] }),
    executorResolver: async (provider: string) => (provider === 'glm' ? adapter : null),
  });

  /**
   * Один синхронный ход чата; потолок ходов защищает квоту от зацикленного сценария.
   * Ответ возвращается разобранным JSON без сырого тела.
   */
  const chat = async (message: string, extra: Record<string, unknown> = {}) => {
    turns += 1;

    if (turns > GLM_SMOKE_MAX_TURNS) {
      throw new Error('Превышен потолок ходов живой проверки');
    }

    const response = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: {
        chatKey: 'glm-smoke',
        modelRef: { provider: 'glm', model },
        message,
        ...extra,
      },
    });

    return { status: response.statusCode as number, body: response.json() as Record<string, any> };
  };
  const step = (name: string, ok: boolean, detail: unknown) => {
    steps.push({
      name,
      ok,
      detail: clean(detail, root, secrets),
    });
  };

  try {
    await app.inject({
      method: 'PUT',
      url: '/api/chat/store/chat',
      payload: {
        chat: {
          id: 'glm-smoke',
          modelRef: { provider: 'glm', model },
          messages: [],
          revision: 0,
        },
      },
    });

    const first = await chat('Ответь одним словом: готово.');

    step('ответ', answered(first.status, first.body),
      first.body.reply ?? first.body.message ?? first.body.error);

    if (!answered(first.status, first.body)) {
      throw new Error('Первый ответ модели не получен; дальнейшие ходы smoke не выполнялись.');
    }

    const tools = await chat('Прочитай marker.txt, замени в нём маркер на тот же текст с суффиксом -EDITED '
      + 'и выполни команду `wc -c marker.txt`. Коротко подтверди.');
    const edited = await fs.readFile(path.join(project, 'marker.txt'), 'utf8').catch(() => '');
    const kinds = new Set((tools.body.steps ?? []).map((item: { k?: string }) => item.k));

    step('маркерные чтение, правка и команда', edited.includes(`${marker}-EDITED`), edited.trim());
    step('размышление и результат инструмента', kinds.has('think') && kinds.has('res'), [...kinds].join(','));

    const memory = await chat('Какой маркер был в файле до правки? Ответь только маркером.');

    step('второй ход и resume', answered(memory.status, memory.body)
      && String(memory.body.reply).includes(marker), memory.body.reply);

    const delegated = await chat('Запусти foreground критика инструментом subagent. '
      + 'Поручи ему прочитать marker.txt и проверить наличие суффикса -EDITED. '
      + 'Дождись результата и коротко сообщи его. Не читай файл сам.');
    const delegationSteps = delegated.body.steps ?? [];
    const parentCalls = new Set(delegationSteps.filter((item: Record<string, unknown>) =>
      item.k === 'tool' && item.name === 'subagent').map((item: Record<string, unknown>) => item.id));
    const childRead = delegationSteps.some((item: Record<string, unknown>) =>
      item.k === 'tool' && item.name === 'Read' && parentCalls.has(item.parent));

    step('foreground критик и дочерняя лента', answered(delegated.status, delegated.body)
      && childRead, childRead ? delegated.body.reply : JSON.stringify(delegationSteps
        .filter((item: Record<string, unknown>) => item.k === 'tool' || item.k === 'res')
        .map((item: Record<string, unknown>) => ({
          k: item.k,
          name: item.name,
          parent: Boolean(item.parent),
          text: item.k === 'res' ? item.text : undefined,
        }))));

    const refusal = await chat('Выполни команду `ssh -p 9 smoke@127.0.0.1 true` и сообщи результат.');
    const refusedSteps = JSON.stringify(refusal.body.steps ?? []);

    step('отказ политики', /запрещ/iu.test(refusedSteps), refusal.body.reply);

    const outside = path.join(root, 'outside.txt');
    const approval = chat('Запиши файл outside.txt уровнем выше рабочей папки, запроси для этого '
      + `расширение песочницы. Путь: ${outside}`);

    const asked = () => events.some((item) => item.event === 'chat-permission');

    for (let attempt = 0; attempt < 600 && !asked(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    await app.inject({
      method: 'POST',
      url: '/api/chat/stop',
      payload: { chatKey: 'glm-smoke' },
    });

    const stopped = await approval;
    const leaked = await fs.stat(outside).then(() => true, () => false);

    // Без запроса подтверждения шаг ничего не проверил: стоп пришёлся не на approval.
    step('стоп во время approval', asked() && !leaked && stopped.status !== 500,
      stopped.body.error ?? stopped.body.reply);

    const turnId = `smoke-${randomUUID().slice(0, 12)}`;
    const accepted = await chat('Ответь одним словом: принято.', { turnId });
    const duplicate = await chat('Ответь одним словом: принято.', { turnId });

    const settled = () => events.some((item) => item.event === 'chat-done' && item.data.turnId === turnId);

    // Принятый ход идёт в фоне: приложение закрывается только после его итога.
    for (let attempt = 0; attempt < 600 && !settled(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    step('F5 и pending', accepted.status === 202 && duplicate.body.duplicate === true && settled(),
      duplicate.body.state);
  } catch (error) {
    step('сценарий', false, (error as Error).message);
  } finally {
    await app.close();
  }

  const modelErrors = await readGlmSmokeHttpErrors(observer.file, options.env, root);

  return {
    kind,
    mode: options.mode,
    compatibility,
    packageId: runtime.metadata!.packageId,
    sha256: runtime.binaryFile!.sha256,
    model,
    turns,
    ok: steps.every((item) => item.ok),
    steps,
    modelErrors,
  };
}

/**
 * Успешная живая проверка дописывает проверенный допуск в выпускную копию
 * compatibility-файла той же рабочей tree, откуда запущен скрипт. Запись режима
 * заменяется целиком, остальные режимы и ревизии не меняются. Следующая сборка
 * замораживает новый список в metadata ELF.
 */
async function admitSmokeCompatibility(mode: GlmAccessMode, compatibility: string): Promise<void> {
  const file = fileURLToPath(new URL('../../deepseek/compatibility/glm.json', import.meta.url));
  const current = JSON.parse(await fs.readFile(file, 'utf8')) as {
    admission?: Array<{ mode: string; compatibility: string }>;
  };

  if (!Array.isArray(current.admission)) {
    throw new TypeError('Файл compatibility не содержит список admission');
  }

  current.admission = [
    ...current.admission.filter((entry) => entry.mode !== mode),
    { mode, compatibility },
  ];

  await fs.writeFile(file, `${JSON.stringify(current, null, 2)}\n`);
  process.stdout.write(`ADMIT ${mode} ${compatibility}\n`);
}

/**
 * Точка входа человека: режим и явное подтверждение живого запуска обязательны.
 * Отчёт пишется в каталог артефактов этапа, временные homes удаляются.
 * `--admit` дописывает допуск только после полностью успешного сценария.
 */
async function main(): Promise<void> {
  const mode = parseGlmAccessMode(shellArgument('--mode'));
  const binary = shellArgument('--binary');
  const cacheDir = shellArgument('--cache-dir');

  if (!mode || !process.argv.includes('--confirm-live')
    || !path.isAbsolute(binary) || !path.isAbsolute(cacheDir)) {
    process.stderr.write('Использование: node server/scripts/glmLiveSmoke.mts --mode api|coding-plan '
      + '--confirm-live --binary <абсолютный ELF> --cache-dir <отдельный cache> '
      + '[--model glm-5.3-flash] [--admit]\n');
    process.exitCode = 2;

    return;
  }

  const reportDir = path.join(artifactsPath({ env: process.env, home: os.homedir() }), 'glm/G12');

  await fs.mkdir(reportDir, { recursive: true });

  const work = await fs.mkdtemp(path.join(reportDir, 'smoke-'));

  try {
    const fileEnv = await readEnvFile(envFilePath({ env: process.env, home: os.homedir() }));
    const report = await runGlmLiveSmoke({
      mode,
      env: {
        ...process.env,
        ...fileEnv,
      },
      config: serviceConfig,
      binary,
      cacheDir,
      model: shellArgument('--model') || undefined,
      workRoot: work,
    });
    const file = path.join(reportDir, `live-smoke-${mode}-${Date.now()}.json`);

    await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${report.ok ? 'OK' : 'FAIL'} ${file}\n`);
    process.exitCode = report.ok ? 0 : 1;

    if (report.ok && process.argv.includes('--admit')) {
      await admitSmokeCompatibility(mode, report.compatibility);
      process.stdout.write('Повторите сборку поставки, чтобы заморозить новый допуск в metadata.\n');
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
