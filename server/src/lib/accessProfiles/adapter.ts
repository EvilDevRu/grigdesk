import type { ExecutorAdapter, ExecutorRunInput } from '../executors/index.ts';
import { withAccessEnvironment } from './runtime.ts';
import { accessService, type AccessProfileService, type SelectedAccess } from './service.ts';
import type { AccessCapability, AccessConfig } from './types.ts';

interface AdapterOptions {
  config?: AccessConfig;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  service?: AccessProfileService;
}

const origins = new WeakMap<object, { adapter: ExecutorAdapter; options: AdapterOptions }>();

/**
 * Отказ доступа наблюдается и у заранее зарезервированного хода, и у живой сессии.
 * Снимок связывает ошибку с прежней ревизией, не затрагивая последующий повторный вход.
 */
async function withSelectedAccess<T>(adapter: ExecutorAdapter, selection: SelectedAccess,
  service: AccessProfileService | undefined, action: () => T): Promise<Awaited<T>> {
  try {
    return await withAccessEnvironment(selection.env, action, selection.isCurrent, selection.keys);
  } catch (error) {
    const code = (error as { code?: string }).code;

    if (service && ['auth_required', 'access_auth_required'].includes(code ?? '')) {
      await service.observe(adapter.id, selection.snapshot, { state: 'auth_required' }, false);
    }

    throw error;
  }
}

/**
 * Служебное окружение хода сохраняет транспорт инструментов и параметры runtime.
 * Поля доступа поверх него всегда задаёт серверный снимок, включая удаление чужих ключей.
 */
function runtimeEnvironment(selection: SelectedAccess, supplied?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...selection.env };

  for (const [key, value] of Object.entries(supplied ?? {})) {
    if (!Object.hasOwn(process.env, key) || value !== process.env[key]) {
      env[key] = value;
    }
  }

  for (const key of selection.keys) {
    delete env[key];

    if (selection.env[key] !== undefined) {
      env[key] = selection.env[key];
    }
  }

  return env;
}

/**
 * Выбранный профиль применяется после входного env, включая session.open.
 * Сам снимок безопасен для метаданных; секреты остаются только в серверном окружении.
 */
function selectedAdapter(adapter: ExecutorAdapter, selection: SelectedAccess,
  service?: AccessProfileService): ExecutorAdapter {
  const capability = adapter.accessProfiles as AccessCapability;
  const result: ExecutorAdapter = { ...adapter };
  const runtimeConfig = (config: AccessConfig) => capability.runtimeConfig?.(config, selection.env) ?? config;
  const bind = (config: AccessConfig) => ({
    ...adapter,
    ...capability.bind?.(selection.env, config, adapter),
  });

  result.catalogAccessScope = () => [selection.profile.id, selection.profile.mode ?? 'default',
    selection.profile.accountGeneration].join('/');

  for (const name of ['run', 'runUntrusted']) {
    if (typeof adapter[name] !== 'function') {
      continue;
    }

    result[name] = async (input: ExecutorRunInput) => {
      const config = runtimeConfig(input.config);
      const bound = bind(config);
      const action = bound[name] as (input: ExecutorRunInput) => unknown;

      return withSelectedAccess(adapter, selection, service, () => action({
        ...input,
        config,
        env: runtimeEnvironment(selection, input.env),
        accessSnapshot: selection.snapshot,
      }));
    };
  }

  if (adapter.sessionBinding) {
    result.sessionBinding = {
      ...adapter.sessionBinding,
      authProfileId: () => `${selection.profile.id}:`
        + `${selection.profile.memoryGeneration ?? selection.profile.accountGeneration}`,
    };
  }

  if (adapter.session && typeof adapter.session.open === 'function') {
    const open = adapter.session.open as (input: Record<string, unknown>) => Promise<unknown>;

    result.session = {
      ...adapter.session,
      async open(input: Record<string, unknown>) {
        const handle = await withSelectedAccess(adapter, selection, service, () => open({
          ...input,
          config: runtimeConfig(input.config as AccessConfig),
          env: runtimeEnvironment(selection, input.env as NodeJS.ProcessEnv | undefined),
          accessSnapshot: selection.snapshot,
        }));

        return new Proxy(handle as object, {
          /**
           * Живые свойства и методы читаются с исходным receiver адаптера.
           * Отправка хода получает прежний снимок и наблюдение ошибки авторизации.
           */
          get(target, key) {
            const value = Reflect.get(target, key, target);

            if (key === 'send' && typeof value === 'function') {
              return (...args: unknown[]) => withSelectedAccess(adapter, selection, service,
                () => Reflect.apply(value, target, args));
            }

            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    };
  }

  for (const name of ['auth', 'catalog', 'catalogCacheKey', 'usage', 'discoverModels', 'mcpStatus']) {
    if (typeof adapter[name] !== 'function' && name !== 'catalogCacheKey') {
      continue;
    }

    result[name] = (config: AccessConfig, ...args: unknown[]) => {
      const selectedConfig = runtimeConfig(config);
      const historyScope = [selection.profile.id, selection.profile.mode ?? 'default',
        selection.profile.accountGeneration].join('/');
      const scoped = capability.scopeConfig?.(selectedConfig, historyScope) ?? selectedConfig;

      const bound = bind(scoped);

      const action = () => typeof bound[name] === 'function'
        ? Reflect.apply(bound[name] as (...args: unknown[]) => unknown, bound, [scoped, ...args]) : '';
      const value = withAccessEnvironment(selection.env, action, selection.isCurrent, selection.keys);

      return name === 'catalogCacheKey'
        ? Promise.resolve(value).then((key) => `${selection.snapshot.scope}:${String(key)}`) : value;
    };
  }

  if (adapter.prepareRuntime) {
    result.prepareRuntime = (config, options) => withAccessEnvironment(selection.env,
      () => adapter.prepareRuntime!(runtimeConfig(config as AccessConfig), options),
      selection.isCurrent, selection.keys);
  }

  if (adapter.nativeSettings) {
    const native = adapter.nativeSettings;
    const context = native.context;

    result.nativeSettings = {
      ...native,
      ...(context ? {
        context: (config, ...rest) => withAccessEnvironment(selection.env,
          () => context(runtimeConfig(config as AccessConfig), ...rest),
          selection.isCurrent, selection.keys),
      } : {}),
      discover: (...args) => withAccessEnvironment(selection.env,
        () => native.discover(...args), selection.isCurrent, selection.keys),
      prepare: (...args) => withAccessEnvironment(selection.env,
        () => native.prepare(...args), selection.isCurrent, selection.keys),
    };
  }

  return result;
}

/**
 * Чат резервирует доступ до подготовки runtime и сравнения native binding.
 * Все последующие методы фасада используют один уже выбранный снимок.
 */
export async function reserveExecutorAccess<T extends object>(adapter: T | null, config: AccessConfig) {
  const origin = adapter ? origins.get(adapter) : undefined;

  if (!origin) {
    return { adapter, release: async () => {} };
  }

  const service = origin.options.service ?? accessService(config);

  if (!origin.adapter.accessProfiles || !service) {
    return { adapter, release: async () => {} };
  }

  const selected = await service.select(origin.adapter.id);

  return selected ? {
    adapter: Object.assign({}, adapter, selectedAdapter(origin.adapter, selected, service)),
    release: selected.release,
  }
    : { adapter, release: async () => {} };
}

/**
 * Декоратор реестра охватывает также служебные вызовы вне chat entrypoint.
 * Чтения не держат work reservation и защищены поколениями кэшей providers.
 */
export function accessProfileAdapter(
  adapter: ExecutorAdapter, options: AdapterOptions = {},
): ExecutorAdapter {
  if (!adapter.accessProfiles || origins.has(adapter)) {
    return adapter;
  }

  const wrapped: ExecutorAdapter = { ...adapter };

  for (const name of ['run', 'runUntrusted', 'auth', 'catalog', 'catalogCacheKey', 'usage',
    'discoverModels', 'mcpStatus', 'catalogAccessScope']) {
    if (typeof adapter[name] !== 'function'
      && !['catalogCacheKey', 'catalogAccessScope'].includes(name)) {
      continue;
    }

    wrapped[name] = async (input: ExecutorRunInput | AccessConfig, ...rest: unknown[]) => {
      const work = name === 'run' || name === 'runUntrusted';
      const config = (work ? (input as ExecutorRunInput).config : input) as AccessConfig;
      const service = options.service ?? accessService(options.config ?? config);
      const selection = await service?.select(adapter.id, work);
      const capability = adapter.accessProfiles as AccessCapability;
      const before = selection && await capability.credentialFingerprint?.(selection.env);

      try {
        const selected = selection ? selectedAdapter(adapter, selection, service) : adapter;

        const result = typeof selected[name] === 'function'
          ? await Reflect.apply(selected[name] as (...args: unknown[]) => unknown,
            selected, [input, ...rest]) : '';

        if (selection && service && !work) {
          const after = await capability.credentialFingerprint?.(selection.env);

          await service.observe(adapter.id, selection.snapshot, result, !!before && before !== after);
        }

        return result;
      } catch (error) {
        const code = (error as { code?: string }).code;

        if (!work && selection && service
          && ['auth_required', 'access_auth_required'].includes(code ?? '')) {
          await service.observe(adapter.id, selection.snapshot, { state: 'auth_required' }, false);
        }

        throw error;
      } finally {
        await selection?.release();
      }
    };
  }

  if (adapter.nativeSettings?.context) {
    const native = adapter.nativeSettings;
    const contexts = new WeakMap<object, NonNullable<ExecutorAdapter['nativeSettings']>>();

    wrapped.nativeSettings = {
      ...native,
      /**
       * Каталог настроек получает тот же профиль, что подготовка чатового runtime.
       * Discover и prepare сохраняют выбор context, даже если active позже изменился.
       */
      async context(config, ...rest) {
        const service = options.service ?? accessService((options.config ?? config) as AccessConfig);
        const selection = await service?.select(adapter.id, false);
        const selected = selection ? selectedAdapter(adapter, selection).nativeSettings! : native;
        const context = await selected.context!(config, ...rest);

        contexts.set(context, selected);

        return context;
      },
      discover: (context, ...rest) => (contexts.get(context) ?? native).discover(context, ...rest),
      prepare: (context, ...rest) => (contexts.get(context) ?? native).prepare(context, ...rest),
    };
  }

  origins.set(wrapped, { adapter, options });

  return wrapped;
}
