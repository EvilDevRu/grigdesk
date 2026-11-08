import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { runtimeRoot } from '../runtimePaths.ts';

const execFileAsync = promisify(execFile);
const FACTORY_HOME = path.join(runtimeRoot(), 'engine');
const STAGE_PROGRESS = path.join(FACTORY_HOME, 'lib/stage-progress.sh');
const STAGE_RESULT = path.join(FACTORY_HOME, 'lib/stage-result.sh');

interface RunContext {
  task: string;
  stage: string;
  runId: string;
  epoch: string;
  requestDir: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Сверяется точная host identity и каталог очереди активного запуска.
 * Модель не может выбрать другой task, stage, run или эпоху.
 */
function runContext(env: NodeJS.ProcessEnv): RunContext {
  const task = String(env.FACTORY_RUN_TASK || '');
  const stage = String(env.FACTORY_RUN_STAGE || '');
  const runId = String(env.FACTORY_RUN_ID || '');
  const epoch = String(env.FACTORY_RUN_EPOCH || '');
  const requestDir = String(env.FACTORY_STATUS_REQUEST_DIR || '');
  const stateDir = String(env.FACTORY_STATE || env.STATE_DIR || '');

  if (!/^[0-9]+$/.test(task)
    || !/^[A-Z][A-Z0-9_]*$/.test(stage)
    || !/^[A-Za-z0-9._-]+$/.test(runId)
    || !/^[1-9][0-9]*$/.test(epoch)
    || env.FACTORY_STATUS_MODE !== 'request'
    || !path.isAbsolute(stateDir)
    || !path.isAbsolute(requestDir)) {
    throw new Error('factory status context invalid');
  }

  const expected = path.join(stateDir, 'logs', 'runs', `t${task}`, stage, runId, 'control-requests');

  if (path.resolve(requestDir) !== path.resolve(expected)) {
    throw new Error('factory status request directory mismatch');
  }

  return {
    task,
    stage,
    runId,
    epoch,
    requestDir,
    stateDir,
    env
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const names = new Set(allowed);

  return Object.keys(value).every((key) => names.has(key));
}

function text(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max) {
    throw new Error(`${label} invalid`);
  }

  return value;
}

/**
 * Списки findings ограничены по объёму и принимают только строки.
 * Их содержательную форму и уникальность проверяет канонический stage-result.
 */
function stringList(value: unknown, label: string, maxItems = 128): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${label} invalid`);
  }

  return value.map((item, index) => text(item, 20000, `${label}[${index}]`));
}

/**
 * Writer получает только доверенный статусный контекст и системные пути.
 * Provider credentials и произвольное окружение CLI в host subprocess не наследуются.
 */
function childEnvironment(context: RunContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: context.env.PATH || '/usr/bin:/bin',
    HOME: context.env.HOME || '',
    LANG: context.env.LANG || 'C.UTF-8',
    LC_ALL: context.env.LC_ALL || '',
    TZ: context.env.TZ || '',
    FACTORY_HOME,
    FACTORY_STATE: context.stateDir,
    STATE_DIR: context.stateDir,
    FACTORY_RUN_TASK: context.task,
    FACTORY_RUN_STAGE: context.stage,
    FACTORY_RUN_ID: context.runId,
    FACTORY_RUN_EPOCH: context.epoch,
    FACTORY_STATUS_MODE: 'request',
    FACTORY_STATUS_REQUEST_DIR: context.requestDir,
    FACTORY_LOOP_ROLE: context.env.FACTORY_LOOP_ROLE || '',
    ...(context.env.FACTORY_CONTROL_ROOT ? {
      FACTORY_CONTROL_ROOT: context.env.FACTORY_CONTROL_ROOT
    } : {}),
  };
  const resultCheck = context.env.FACTORY_STAGE_RESULT_CHECK;

  if (resultCheck && path.isAbsolute(resultCheck) && !resultCheck.includes('\0')) {
    env.FACTORY_STAGE_RESULT_CHECK = resultCheck;
  }

  return env;
}

/**
 * Штатный writer выполняется вне namespace с ограниченными временем и выводом.
 * Отказ возвращается инструменту, не подменяя результат стадии успешным JSON.
 */
async function invoke(script: string, args: string[], context: RunContext) {
  try {
    const { stdout, stderr } = await execFileAsync(script, args, {
      cwd: context.stateDir,
      env: childEnvironment(context),
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 64 * 1024,
      shell: false,
    });

    return {
      content: [{
        type: 'text',
        text: String(stdout || stderr || 'ok').trim().slice(0, 2000) || 'ok'
      }],
      structuredContent: {
        ok: true
      },
    };
  } catch (error) {
    const detail = error as {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      message?: unknown;
    };
    const code = typeof detail.code === 'number' ? detail.code : 1;
    const message = String(detail.stderr || detail.stdout || detail.message || 'status command failed')
      .trim().slice(-2000);

    return {
      content: [{
        type: 'text',
        text: message || `status command failed (${code})`
      }],
      structuredContent: {
        ok: false,
        exitCode: code
      },
      isError: true,
    };
  }
}

/**
 * Progress принимает только пары ключ/значение без произвольной identity.
 * Допустимые ключи и запрет ROUTE_BY=human проверяет engine writer.
 */
async function stageProgress(argumentsValue: unknown, context: RunContext) {
  if (!record(argumentsValue) || !exactKeys(argumentsValue, ['updates'])
    || !Array.isArray(argumentsValue.updates)
    || argumentsValue.updates.length < 1 || argumentsValue.updates.length > 64) {
    throw new Error('stage_progress arguments invalid');
  }

  const pairs: string[] = [];

  for (const [index, update] of argumentsValue.updates.entries()) {
    if (!record(update) || !exactKeys(update, ['key', 'value'])) {
      throw new Error(`stage_progress updates[${index}] invalid`);
    }

    const key = text(update.key, 80, `updates[${index}].key`);
    const value = text(update.value, 20000, `updates[${index}].value`);

    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      throw new Error(`updates[${index}].key invalid`);
    }

    pairs.push(key, value);
  }

  return invoke(STAGE_PROGRESS, [
    '--task', context.task,
    '--stage', context.stage,
    '--run-id', context.runId,
    '--epoch', context.epoch,
    ...pairs,
  ], context);
}

/**
 * Поля typed verdict переводятся в argv штатного writer без собственной семантики.
 * Граница этапа требует host роли lead и сохраняет findings, closes и summary.
 */
async function stageResult(argumentsValue: unknown, context: RunContext) {
  const allowed = [
    'result', 'comment', 'failureOwner', 'findings', 'deferredFindings',
    'findingAnchors', 'reviewed',
    'nextStage', 'stageClosed', 'stageSummary',
  ];

  if (!record(argumentsValue) || !exactKeys(argumentsValue, allowed)) {
    throw new Error('stage_result arguments invalid');
  }

  const result = text(argumentsValue.result, 16, 'result');

  if (!['done', 'skipped', 'failed'].includes(result)) {
    throw new Error('result invalid');
  }

  const comment = text(argumentsValue.comment ?? '', 20000, 'comment');
  const failureOwner = argumentsValue.failureOwner === undefined
    ? ''
    : text(argumentsValue.failureOwner, 120, 'failureOwner');
  const findings = stringList(argumentsValue.findings, 'findings');
  const deferred = stringList(argumentsValue.deferredFindings, 'deferredFindings');
  const anchors = stringList(argumentsValue.findingAnchors, 'findingAnchors');
  const reviewed = stringList(argumentsValue.reviewed, 'reviewed');
  const closes = stringList(argumentsValue.stageClosed, 'stageClosed');
  const hasStage = ['nextStage', 'stageClosed', 'stageSummary'].some((key) => key in argumentsValue);

  if (hasStage && (context.env.FACTORY_LOOP_ROLE !== 'lead' || argumentsValue.nextStage !== true)) {
    throw new Error('Граница этапа доступна только доверенной роли lead');
  }

  const args = [
    '--task', context.task,
    '--stage', context.stage,
    '--run-id', context.runId,
    '--epoch', context.epoch,
  ];

  if (failureOwner) {
    args.push('--failure-owner', failureOwner);
  }

  for (const finding of findings) {
    args.push('--finding', finding);
  }

  for (const finding of deferred) {
    args.push('--finding-deferred', finding);
  }

  for (const anchor of anchors) {
    args.push('--finding-anchor', anchor);
  }

  for (const item of reviewed) {
    args.push('--reviewed', item);
  }

  if (hasStage) {
    args.push('--next-stage');

    for (const closed of closes) {
      args.push('--stage-closed', closed);
    }

    args.push('--stage-summary', text(argumentsValue.stageSummary, 500, 'stageSummary'));
  }

  args.push(result, comment);

  return invoke(STAGE_RESULT, args, context);
}

/**
 * Схема открывает границу цикла только при доверенной host роли lead.
 * Остальные consumers получают прежний набор полей терминального результата.
 */
export function factoryStatusDescriptors(env: NodeJS.ProcessEnv) {
  return [
    {
      name: 'stage_progress',
      description: 'Обновить проверяемый прогресс текущего Factory-этапа.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['updates'],
        properties: {
          updates: {
            type: 'array',
            minItems: 1,
            maxItems: 64,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['key', 'value'],
              properties: {
                key: {
                  type: 'string'
                },
                value: {
                  type: 'string'
                }
              },
            },
          },
        },
      },
    },
    {
      name: 'stage_result',
      description: 'Зафиксировать единственный терминальный результат текущего Factory-этапа.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['result'],
        properties: {
          result: {
            type: 'string',
            enum: ['done', 'skipped', 'failed']
          },
          comment: {
            type: 'string'
          },
          failureOwner: {
            type: 'string'
          },
          findings: {
            type: 'array',
            items: {
              type: 'string'
            }
          },
          deferredFindings: {
            type: 'array',
            items: {
              type: 'string'
            }
          },
          findingAnchors: {
            type: 'array',
            items: {
              type: 'string'
            }
          },
          reviewed: {
            type: 'array',
            items: {
              type: 'string'
            }
          },
          ...(env.FACTORY_LOOP_ROLE === 'lead' ? {
            nextStage: {
              type: 'boolean'
            },
            stageClosed: {
              type: 'array',
              items: {
                type: 'string'
              }
            },
            stageSummary: {
              type: 'string'
            },
          } : {}),
        },
      },
    },
  ];
}

/**
 * Только host назначает identity и loop role; модель передаёт ограниченные поля вердикта.
 * Фактическую форму и актуальность сдачи проверяют штатный writer и launcher consumer.
 */
export async function invokeFactoryStatusTool(env: NodeJS.ProcessEnv, name: string, input: unknown) {
  const context = runContext(env);

  if (name === 'stage_progress') {
    return stageProgress(input, context);
  }

  if (name === 'stage_result') {
    return stageResult(input, context);
  }

  throw new Error('Неизвестный статусный инструмент');
}

/**
 * ACP получает только узкий WorkToolsPort, а writers исполняются на host вне sandbox.
 * Неудачная сдача остаётся ошибкой инструмента и не превращается в результат стадии.
 */
export function createFactoryStatusPort(env: NodeJS.ProcessEnv) {
  runContext(env);

  return {
    descriptors: factoryStatusDescriptors(env),
    async invoke(name: string, input: Record<string, unknown>) {
      const result = await invokeFactoryStatusTool(env, name, input);

      if ('isError' in result && result.isError) {
        throw new Error(result.content[0]?.text || 'Статус отклонён');
      }

      return {
        ok: true
      };
    },
  };
}
