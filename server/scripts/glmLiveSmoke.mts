// Живая проверка режима GLM до допуска (G12). Запускает человек, когда выбран режим, ключ
// режима лежит в окружении службы, а для coding-plan подтверждено право использовать подписку.
// Скрипт не меняет GLM_ADMISSION, не читает и не печатает ключ, ограничивает число ходов
// сценарием и пишет очищенный отчёт в glm/G12/ папки артефактов.
//
// Запуск: node server/scripts/glmLiveSmoke.mts --mode api|coding-plan --confirm-live
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
import { describeGlmGeneration } from '../src/lib/glm/generation.ts';
import chatModule from '../src/modules/chat/index.ts';

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
 * Ключа в тексте быть не может: скрипт его не читает, а ход его не видит.
 */
function clean(value: unknown, root: string): string {
  return String(value ?? '').replaceAll(root, '<tmp>').slice(0, 400);
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
  const root = await fs.mkdtemp(path.join(options.workRoot, 'live-'));
  const project = path.join(root, 'project');
  const marker = `GLM-SMOKE-${randomUUID().slice(0, 8)}`;
  const model = JSON.stringify(['zai', options.model ?? 'glm-5.3']);
  const config = {
    ...options.config,
    rootDir: project,
    chatsDir: path.join(root, 'chats'),
    chatStoreLegacyPath: path.join(root, 'legacy.json'),
    chatBindingsDir: path.join(root, 'bindings'),
    glmRuntimeHome: path.join(root, 'glm-home'),
  };
  const runtime = describeGlmGeneration(config).runtime;
  const compatibility = glmCompatibilityIdentity(runtime, options.mode);
  const adapter = createGlmAdapter({
    env: options.env,
    admission: [{ mode: options.mode, compatibility }],
    ...options.adapterDeps,
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
      detail: clean(detail, root),
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

    step('ответ', answered(first.status, first.body), first.body.reply ?? first.body.error);

    const tools = await chat('Прочитай marker.txt, замени в нём маркер на тот же текст с суффиксом -EDITED '
      + 'и выполни команду `wc -c marker.txt`. Коротко подтверди.');
    const edited = await fs.readFile(path.join(project, 'marker.txt'), 'utf8').catch(() => '');
    const kinds = new Set((tools.body.steps ?? []).map((item: { k?: string }) => item.k));

    step('маркерные чтение, правка и команда', edited.includes(`${marker}-EDITED`), edited.trim());
    step('размышление и результат инструмента', kinds.has('think') && kinds.has('res'), [...kinds].join(','));

    const memory = await chat('Какой маркер был в файле до правки? Ответь только маркером.');

    step('второй ход и resume', answered(memory.status, memory.body)
      && String(memory.body.reply).includes(marker), memory.body.reply);

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

  return {
    mode: options.mode,
    compatibility,
    model,
    turns,
    ok: steps.every((item) => item.ok),
    steps,
  };
}

/**
 * Точка входа человека: режим и явное подтверждение живого запуска обязательны.
 * Отчёт пишется в каталог артефактов этапа, временные homes удаляются.
 */
async function main(): Promise<void> {
  const mode = parseGlmAccessMode(shellArgument('--mode'));

  if (!mode || !process.argv.includes('--confirm-live')) {
    process.stderr.write('Использование: node server/scripts/glmLiveSmoke.mts --mode api|coding-plan '
      + '--confirm-live [--model glm-5.3]\n');
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
      model: shellArgument('--model') || undefined,
      workRoot: work,
    });
    const file = path.join(reportDir, `live-smoke-${mode}-${Date.now()}.json`);

    await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${report.ok ? 'OK' : 'FAIL'} ${file}\n`);
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
