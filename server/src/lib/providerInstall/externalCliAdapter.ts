import { isRecord } from '../../../../shared/lib/objects.ts';
import type { ExecutorAdapter } from '../executors/index.ts';
import type { NativeSettingsContext } from '../executorSettings/types.ts';
import { prepareExternalCliRuntime, type ExternalCliRuntime } from './externalCliRuntime.ts';
import { withExternalCliProcess } from './externalCliProcess.ts';
import { settingsFingerprint } from '../executorSettings/fingerprint.ts';

/**
 * Opt-in адаптер получает один выбор программы для probe, настроек и чата.
 * Managed/API адаптер без capability сохраняет прежние функции и окружение.
 */
export function externalCliAdapter(adapter: ExecutorAdapter, parent = process.env): ExecutorAdapter {
  if (!adapter.externalCli) {
    return adapter;
  }

  const wrapped: ExecutorAdapter = { ...adapter };
  const runtimeByHandle = new WeakMap<object, ExternalCliRuntime | null>();
  const runtimeByPlan = new Map<string, {
    runtime: ExternalCliRuntime | null;
    payloadFingerprint: string;
  }>();

  if (adapter.prepareRuntime) {
    const prepare = adapter.prepareRuntime;

    wrapped.prepareRuntime = async (config, options) => {
      const runtime = await prepareExternalCliRuntime(adapter, config, parent);
      const action = () => prepare(runtime?.config ?? config, options);
      const handle = await (runtime ? withExternalCliProcess(runtime.process, action) : action());

      runtimeByHandle.set(handle, runtime);

      return handle;
    };
  }

  /**
   * Подготовленный handle закрепляет один executable и окружение до самого spawn.
   * Поддельный handle не запускает повторный discovery и не получает fallback в PATH.
   */
  const invokePrepared = async (config: unknown, handle: unknown,
    action: (selected: unknown) => unknown) => {
    if (!handle || !adapter.prepareRuntime) {
      return invoke(config, action);
    }
    if (typeof handle !== 'object' || !runtimeByHandle.has(handle)) {
      throw new Error('Чужой runtime handle внешнего CLI');
    }

    const runtime = runtimeByHandle.get(handle);

    return runtime
      ? withExternalCliProcess(runtime.process, () => action(runtime.config))
      : action(config);
  };
  const invoke = async (config: unknown, action: (config: unknown) => unknown) => {
    const runtime = await prepareExternalCliRuntime(adapter, config, parent);

    return runtime ? withExternalCliProcess(runtime.process, () => action(runtime.config)) : action(config);
  };

  for (const name of ['probe', 'usage', 'modes', 'efforts', 'catalog', 'discoverModels',
    'mcpStatus', 'scopedWorkspace']) {
    const action = adapter[name];

    if (typeof action !== 'function') {
      continue;
    }

    wrapped[name] = async (config: unknown, ...rest: unknown[]) => {
      try {
        return await invoke(config, (selected) => Reflect.apply(action, adapter, [selected, ...rest]));
      } catch (error) {
        if (name !== 'probe') {
          throw error;
        }

        return {
          ok: false,
          version: null,
          error: 'Не удалось проверить выбранный внешний CLI',
        };
      }
    };
  }

  const wrapInput = (action: (...args: never[]) => unknown, owner: object) =>
    async (input: unknown, ...rest: unknown[]) => {
      if (!isRecord(input)) {
        throw new Error('Некорректный контекст запуска исполнителя');
      }

      if (input.preparedRuntime && isRecord(input.nativeSettings)) {
        const runtime = typeof input.preparedRuntime === 'object'
          ? runtimeByHandle.get(input.preparedRuntime) : undefined;
        const prepared = runtimeByPlan.get(String(input.nativeSettings.fingerprint));

        if (!prepared || prepared.payloadFingerprint !== settingsFingerprint(input.nativeSettings.payload)
          || settingsFingerprint(runtime?.process) !== settingsFingerprint(prepared.runtime?.process)) {
          throw new Error('Нативные настройки подготовлены для другого runtime');
        }
      }

      return invokePrepared(input.config, input.preparedRuntime,
        (config) => Reflect.apply(action, owner, [{ ...input, config }, ...rest]));
    };

  for (const name of ['run', 'runUntrusted']) {
    const action = adapter[name];

    if (typeof action === 'function') {
      wrapped[name] = wrapInput(action as (...args: never[]) => unknown, adapter);
    }
  }

  const session = adapter.session;

  if (session && typeof session.open === 'function') {
    const open = wrapInput(session.open as (...args: never[]) => unknown, session);

    wrapped.session = {
      ...session,
      /**
       * Повторный send выполняется позднее open и должен сохранить его process context.
       * Иначе проверка runtime при reuse обращалась бы к другому окружению и CLI.
       */
      async open(input: Record<string, unknown>, ...rest: unknown[]) {
        const handle = await open(input, ...rest) as Record<string, unknown>;
        const runtime = input.preparedRuntime && typeof input.preparedRuntime === 'object'
          ? runtimeByHandle.get(input.preparedRuntime) : undefined;

        if (!runtime || typeof handle.send !== 'function') {
          return handle;
        }

        const send = handle.send as (...args: unknown[]) => unknown;
        const original = handle;

        return new Proxy(original, {
          get(target, key) {
            return key === 'send'
              ? (...args: unknown[]) => withExternalCliProcess(runtime.process,
                () => Reflect.apply(send, original, args))
              : Reflect.get(target, key);
          },
        });
      },
    };
  }

  const capability = adapter.nativeSettings;

  if (capability?.context) {
    const contextOf = capability.context;
    const runtimeByContext = new WeakMap<NativeSettingsContext, ExternalCliRuntime | null>();

    wrapped.nativeSettings = {
      ...capability,
      /**
       * Контекст получает тот же выбранный CLI и окружение, что probe и run.
       * Ошибка подготовки возвращает обычный контекст адаптера, не чужую копию.
       */
      async context(config, ...rest) {
        const handle = rest[2];

        if (handle && adapter.prepareRuntime && !runtimeByHandle.has(handle)) {
          throw new Error('Чужой runtime handle нативных настроек');
        }

        const runtime = handle && adapter.prepareRuntime
          ? runtimeByHandle.get(handle) ?? null
          : await prepareExternalCliRuntime(adapter, config, parent);
        const action = () => contextOf(runtime?.config ?? config, ...rest);
        const context = await (runtime ? withExternalCliProcess(runtime.process, action) : action());

        if (handle && adapter.runtimeProfileFingerprint) {
          context.profileFingerprint = settingsFingerprint([
            context.profileFingerprint, adapter.runtimeProfileFingerprint(handle),
          ]);
        }

        runtimeByContext.set(context, runtime);

        return context;
      },
      discover(context, options) {
        const runtime = runtimeByContext.get(context);
        const action = () => capability.discover(context, options);

        return runtime ? withExternalCliProcess(runtime.process, action) : action();
      },
      /**
       * Проверенный план настроек остаётся связан с выбранным CLI своего context.
       * Переданный извне plan не может подменить подготовку другого процесса.
       */
      async prepare(context, ...rest) {
        const runtime = runtimeByContext.get(context);
        const plan = await capability.prepare(context, ...rest);

        runtimeByPlan.set(settingsFingerprint({ context, accepted: plan.accepted }), {
          runtime: runtime ?? null,
          payloadFingerprint: settingsFingerprint(plan.payload),
        });

        if (runtimeByPlan.size > 128) {
          runtimeByPlan.delete(runtimeByPlan.keys().next().value!);
        }

        return plan;
      },
    };
  }

  return wrapped;
}
