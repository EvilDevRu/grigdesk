import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

import { ArbiterConversationError } from '../../../../shared/pipeline/arbiterConversation.ts';
import type { ApplyReceipt, StopIdentity } from '../../../../shared/pipeline/arbiterConversation.ts';
import { ArbiterConversationService } from '../../lib/arbiterConversationService.ts';
import { ArbiterConversationApply } from '../../lib/arbiterConversationApply.ts';
import type { ArbiterConversationStore } from '../../lib/arbiterConversationStore.ts';
import { readArbiterStopContext } from '../../lib/arbiterStopContext.ts';
import { probeFactoryGotoCapability } from '../../lib/factoryRuntimeCapabilities.ts';
import { readExistingFactoryRuntimePin } from '../../lib/factoryRuntimePins.ts';
import { normalizeArbiterSettings, resolveArbiterTarget } from '../../lib/factoryArbiter.ts';
import { resolveModelRef } from '../../lib/chat/modelRef.ts';
import { getModelsRegistry } from '../../lib/modelsRegistry.ts';
import { runRouteDecision, routeGotoArgs } from '../../lib/factoryRouteCli.ts';
import { dataPath } from '../../../../shared/runtime/dataHome.ts';
import { config as runtimeConfig } from '../../config.ts';
import type { FactoryModuleOptions } from './index.ts';
import type { ArbiterExecutor } from '../../lib/factoryArbiter.ts';
import type { FastifyInstance } from 'fastify';
import { registerArbiterConversationRoutes } from './arbiterConversationRoutes.ts';

const execute = promisify(execFile);

type Trusted = Awaited<ReturnType<FactoryModuleOptions['factoryState']['readTrustedAttempt']>>;

/**
 * Проверенный lifecycle связывает запуск с exact rewind и визитом выбранного узла.
 * Сам ready cursor и живой процесс соседнего визита не доказывают запуск этого этапа.
 */
async function visitStarted(options: FactoryModuleOptions, trusted: Trusted, receipt: ApplyReceipt) {
  const { config, factoryState } = options;
  const { registry } = await factoryState.readRegistry(trusted.task);

  if (registry.ATTEMPT_ID !== trusted.attempt
    || !factoryState.isDaemonAlive(registry.ORCH_PID, trusted.task)) {
    return false;
  }

  try {
    const pin = await readExistingFactoryRuntimePin({
      controlRoot: config.factoryControlDir,
      stateRoot: config.stateDir,
      profileRoot: config.profilesDir,
      cacheDir: config.runtime?.cacheDir
        ?? dataPath(
          config.dataHome
          ?? runtimeConfig.dataHome,
          'serverRuntime'
        ),
      task: trusted.task,
      attempt: trusted.attempt,
      profile: trusted.profile || '',
    });

    if (!pin) {
      return false;
    }

    const result = await execute('python3', [
      path.join(pin.engineHome, 'lib/attempt-lifecycle-state.py'),
      '--schema', path.join(pin.runtimeRoot, 'schemas/analytics/lifecycle-event.schema.json'),
      '--segment-bytes', '16777216', 'read',
      path.join(
        config.factoryControlDir,
        'protocol-v2/tasks',
        `t${trusted.task}`,
        'attempts',
        trusted.attempt
      ),
      `t${trusted.task}`, trusted.attempt,
    ], {
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
    });

    return result.stdout.trim().split('\n').some((line) => {
      const event = JSON.parse(line);

      return event.kind === 'node_visit_started' && event.attemptId === trusted.attempt
        && event.nodeId === receipt.targetNode
        && event.details?.stageEventHash === receipt.stage.headEventHash;
    });
  } catch {
    return false;
  }
}

/**
 * Связывает старый HTTP-вход, watcher и новый диалог одним владельцем job и admission.
 * Выбор модели остаётся в общих адаптерах исполнителей, возврат — только в apply port.
 */
export async function registerArbiterConversationRuntime(
  fastify: FastifyInstance,
  options: FactoryModuleOptions,
  store: ArbiterConversationStore,
  executorResolver: (provider: string) => Promise<ArbiterExecutor | null>,
  resume: (trusted: Trusted) => Promise<{ ok: boolean; message?: string }>,
) {
  const { config, factoryState, prefs, arbiterLive } = options;
  const apply = new ArbiterConversationApply({
    store,
    controlDir: config.factoryControlDir,
    readTrusted: (task) => factoryState.readTrustedAttempt(task),
    goto: (identity, action, reason, expectedStage) => runRouteDecision(config, routeGotoArgs(config, {
      task: identity.task,
      profile: identity.profile,
      attempt: identity.attempt,
      node: action.targetNode,
      reason,
      expectedStage,
    })),
    resume,
    running: (trusted, receipt) => visitStarted(options, trusted, receipt),
    handoff: (task) => factoryState.beginHandoff(task),
  });
  /**
   * Отсутствие поддержанного stop отличается от недоступного trusted журнала.
   * Ошибка целостности никогда не разрешает применение по старой проекции.
   */
  const readContext = async (task: string) => {
    try {
      return await readArbiterStopContext(factoryState, config, task);
    } catch (error) {
      if (error instanceof ArbiterConversationError && error.code === 'not_arbitrable') {
        return null;
      }

      throw new ArbiterConversationError('attempt_integrity_failed',
        'Не удалось подтвердить данные текущей остановки. Обновите состояние.', 409);
    }
  };
  const service = new ArbiterConversationService({
    store,
    readContext,
    capabilities: async (context) => ({
      ...await probeFactoryGotoCapability(config, context.identity), targets: context.targets,
    }),
    prepareRun: async (context) => {
      const settings = normalizeArbiterSettings(prefs?.read()?.arbiter);
      const target = await resolveArbiterTarget({
        modelRef: { ...(settings.modelRef || {}), effort: settings.effort },
        config,
        modelsRegistry: () => getModelsRegistry(config),
        executorResolver,
        resolveRef: resolveModelRef,
        log: fastify.log,
      });

      if (!target.ok) {
        throw new ArbiterConversationError(target.error, target.message, 409);
      }

      const trusted = await factoryState.readTrustedAttempt(context.identity.task);
      const repos = trusted.repositories;

      if (!repos[0]) {
        throw new ArbiterConversationError(
          'arbiter_workspace_unavailable',
          'Рабочее дерево задачи недоступно.',
          409
        );
      }

      const providerSettings = prefs?.read()?.providerSettings as Record<string, Record<string, unknown>>;

      return {
        executor: target.executor,
        input: {
          config,
          cwd: repos[0].workspace,
          extraDirs: [...repos.slice(1).map((repo) => repo.workspace), config.stateDir],
          model: target.ref.model,
          effort: target.effort || undefined,
          permissionMode: target.permissionMode,
          providerSettings: providerSettings?.[target.ref.provider] || {},
          log: fastify.log,
        },
      };
    },
    live: arbiterLive || undefined,
    onError: (error) => fastify.log.error(
      { err: error },
      'Не удалось сохранить или завершить разбор остановки'
    ),
    apply: (doc, operation) => apply.apply(doc, operation),
    resume: (doc, operation, body) => apply.resume(doc, operation, body),
    validateResume: (doc, body) => apply.validateResume(doc, body),
    recoverApply: (doc) => apply.recover(doc),
    observe: async (doc) => {
      if (doc.operations.some((row) => row.kind === 'apply' && row.outcome === 'unknown')) {
        await apply.recover(doc);
      }

      await apply.observe(doc);
    },
    owner: async (identity: StopIdentity) => {
      const attempt = path.join(config.factoryControlDir, 'protocol-v2/tasks',
        `t${identity.task}`, 'attempts', identity.attempt);
      const exists = await fs.lstat(attempt).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          return false;
        }

        throw error;
      });

      if (exists) {
        return 'present';
      }

      // Недоступный каталог не доказывает удаление; обе области должны прочитаться.
      const active = await fs.readdir(config.stateDir);
      const archived = await fs.readdir(path.join(
        config.stateDir,
        'archive'
      )).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          return [];
        }

        throw error;
      });

      return [...active, ...archived].some((name) => name.startsWith(`t${identity.task}.`))
        ? 'present' : 'absent';
    },
  });

  await service.recover();
  registerArbiterConversationRoutes(fastify, service, { stateDir: config.stateDir });
  fastify.addHook('onClose', () => service.close());

  /**
   * Старый адрес запускает тот же durable разбор, которым владеет новый диалог.
   * Completion остаётся внутреннему watcher, HTTP подтверждает только сохранённую операцию.
   */
  const runArbitration = async (task: string, reply: {
    code: (status: number) => { send: (body: unknown) => unknown };
  }, { actor = 'human' } = {}) => {
    try {
      const current = await service.current(task);

      if (!current.identity) {
        throw new ArbiterConversationError('not_arbitrable', 'Сейчас нет остановки для разбора.', 409);
      }

      return await service.start(
        task,
        {
          requestId: randomUUID(),
          expectedStop: current.identity
        },
        actor === 'auto'
      );
    } catch (error) {
      const failure = error instanceof ArbiterConversationError ? error
        : new ArbiterConversationError('arbiter_run_failed', 'Разбор не удалось начать.', 503);

      reply.code(failure.statusCode).send({ error: failure.code, message: failure.message });

      return null;
    }
  };

  fastify.post<{ Params: { id: string } }>('/api/tasks/:id/arbitrate', async (request, reply) => {
    const result = await runArbitration(request.params.id, reply);

    if (!result) {
      return reply;
    }

    const { completion: _completion, ...ack } = result;

    return reply.code(202).send(ack);
  });
  fastify.decorate('factoryArbitrate', runArbitration);

  return service;
}
