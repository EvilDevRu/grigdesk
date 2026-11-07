import type { PluginModuleStart } from '../../../packages/plugin-types/src/web.js';
import { reactive, ref } from 'vue';
import type { Component } from 'vue';
import { UiButton, confirmDialog, useUiLayer } from '../ui.ts';
import type { PluginWebModule } from '../../../shared/plugins/pluginsContracts.ts';
import { isRecord } from '../../../shared/lib/objects.ts';
import { isPluginModuleDescriptor } from './descriptor.ts';
import { loadPluginStyles } from './styles.ts';

export type ImportModule = (specifier: string) => Promise<Record<string, unknown>>;

export class PluginModuleError extends Error {
  constructor(readonly code: 'unsupported' | 'load-failed') {
    super(code);
  }
}

const nativeImport: ImportModule = (specifier) => import(/* @vite-ignore */ specifier);

/**
 * Фасады проверяются реальными import и сравнением ссылок до исполнения плагина.
 * Ядро не ожидает эту проверку; сбой карты остаётся ошибкой отдельной панели.
 */
export async function sharedRuntime(importModule: ImportModule): Promise<void> {
  try {
    const [vue, ui] = await Promise.all([importModule('vue'), importModule('@grigdesk/ui')]);

    if (vue.ref !== ref || vue.reactive !== reactive || ui.UiButton !== UiButton
      || ui.confirmDialog !== confirmDialog || ui.useUiLayer !== useUiLayer) {
      throw new PluginModuleError('unsupported');
    }
  } catch {
    throw new PluginModuleError('unsupported');
  }
}

/**
 * Единый срок ограничивает карту, CSS и import, который браузер физически не отменяет.
 * Поздние результаты не публикуются, а принадлежащие попытке стили освобождаются.
 */
export async function loadPluginModule(
  pluginId: string,
  descriptor: PluginWebModule,
  options: {
    signal: AbortSignal;
    importModule?: ImportModule;
    styles?: boolean;
  },
): Promise<{
  component: Component;
  start: PluginModuleStart | undefined;
  releaseStyles: () => void;
}> {
  if (!isPluginModuleDescriptor(pluginId, descriptor)) {
    throw new PluginModuleError('load-failed');
  }

  const controller = new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  const importModule = options.importModule ?? nativeImport;
  let releaseStyles = () => {};
  let removeAbort = () => {};

  options.signal.throwIfAborted();
  options.signal.addEventListener('abort', abort, { once: true });

  const timer = setTimeout(() => controller.abort(new PluginModuleError('load-failed')), 30_000);
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(controller.signal.reason);

    controller.signal.addEventListener('abort', onAbort, { once: true });
    removeAbort = () => controller.signal.removeEventListener('abort', onAbort);
  });
  /**
   * Внешний entry запускается только после общей identity и загрузки его CSS.
   * Между ожиданиями проверяем отмену, чтобы не исполнить устаревшую попытку.
   */
  const load = async () => {
    await sharedRuntime(importModule);
    controller.signal.throwIfAborted();

    if (options.styles !== false) {
      releaseStyles = await loadPluginStyles(descriptor.css, controller.signal);
    }

    controller.signal.throwIfAborted();

    const module = await importModule(descriptor.entry);
    const component = module.default;

    controller.signal.throwIfAborted();

    if (typeof component !== 'function' && (!isRecord(component)
      || typeof component.setup !== 'function' && typeof component.render !== 'function')) {
      throw new PluginModuleError('load-failed');
    }

    return {
      component: component as Component,
      start: module.start as PluginModuleStart | undefined,
      releaseStyles,
    };
  };

  try {
    return await Promise.race([load(), aborted]);
  } catch (error) {
    controller.abort(error);
    releaseStyles();

    throw error instanceof PluginModuleError || options.signal.aborted
      ? error : new PluginModuleError('load-failed');
  } finally {
    clearTimeout(timer);
    removeAbort();
    options.signal.removeEventListener('abort', abort);
  }
}
