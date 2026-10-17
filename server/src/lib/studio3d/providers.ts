// Реестр раздела получает узкие исполнители через capability, не через имя вендора.
// Предложения используют словарь действий и проверенное происхождение версии.
import path from 'node:path';

import { normalizeExecutorType } from '../../../../shared/chat/executorTypes.ts';
import {
  normalizeValues,
  operationsFor,
} from '../../../../shared/studio3d/studio3dOperations.ts';
import type { ProviderOperation } from '../../../../shared/studio3d/studio3dOperations.ts';
import type { Studio3dOffer } from '../../../../shared/studio3d/studio3dContracts.ts';
import type { ExecutorAdapter } from '../executors/index.ts';
import { createLocalStudio } from './local.ts';
import { START_CONTEXT } from './provider.ts';
import type { AccountSnapshot, InputContext, Studio3dProvider } from './provider.ts';
import type { DiskVersion } from './library.ts';

export interface OffersOptions {
  providers: Studio3dProvider[];
  context?: InputContext;
  version?: DiskVersion | null;
  uploads?: {
    role?: string;
    name?: string;
    kind?: string;
  }[];
}

/**
 * Узкие карточки обязаны явно объявить studio3d. Универсальный transport
 * не попадает в раздел даже при ошибочно добавленном поле.
 */
export function studioProviders({ adapters, local = createLocalStudio() }: {
  adapters: ReadonlyMap<string, ExecutorAdapter>;
  local?: Studio3dProvider;
}): Studio3dProvider[] {
  return [...adapters.values()].filter((adapter) => normalizeExecutorType(adapter.type) === '3d'
    && adapter.studio3d).map((adapter) => adapter.studio3d!).concat(local);
}

/**
 * Native принадлежит самой версии и текущему аккаунту, предки не наследуются.
 * Rig результат доступен только в ready, неизвестная высота остаётся null.
 */
export function inputContext(
  version: DiskVersion | null | undefined,
  provider: Studio3dProvider,
  captured?: AccountSnapshot,
): InputContext {
  if (!version) {
    return structuredClone(START_CONTEXT);
  }

  const account = captured ?? provider.snapshot?.();
  const native = version.task?.provider === provider.id && version.accountKey !== null
    && version.accountKey === account?.accountKey && version.status !== 'remote';
  const file = version.files.find((item) => item.id === version.mainFileId)
    ?? version.files.find((item) => ['model', 'file', 'image'].includes(item.role));

  return {
    kind: version.kind,
    format: file ? path.extname(file.name).slice(1).toLowerCase() : null,
    stats: version.stats,
    params: version.params,
    nativeTaskType: native ? version.task!.type : null,
    rigCheck: version.rigCheck?.status === 'ready' ? {
      riggable: version.rigCheck.riggable,
      rigType: version.rigCheck.rigType
    } : null,
    views: version.views,
  };
}

/**
 * Причина доступности относится к capability/входу, не заменяет validate run.
 * Неизвестный rig набор и недостоверная высота не получают запасные значения.
 */
function reasonFor(
  operation: ProviderOperation,
  context: InputContext,
  provider: Studio3dProvider,
  available: boolean,
): string | null {
  if (!available) {
    return `Нужен ключ ${provider.name} — «Настройки → Исполнители».`;
  }

  if (operation.needsNative && !provider.nativeAccepts?.(operation.operation, context.nativeTaskType)) {
    return operation.operation === 'animate'
      ? `Для этого шага нужна версия, где скелет, поставленный ${provider.name}.`
      : 'Для этого шага нужна доступная версия этого исполнителя.';
  }

  if (operation.needsNative && operation.fields.some((field) => field.kind === 'multiselect'
    && field.required && !field.options?.length)) {
    return 'Версия и тип скелета неизвестны — набор движений недоступен.';
  }

  if (provider.local && context.format !== 'glb') {
    return 'Помощники работают только с сохранённым GLB.';
  }

  if (provider.local && operation.operation === 'scale' && !((context.stats?.size?.[1] ?? 0) > 0)) {
    return 'Высота модели неизвестна — рост задать нельзя.';
  }

  return null;
}

/**
 * Offers не создаёт заказ и не загружает входы. Бесплатный native preflight
 * выполняется со снимком доступа; истёкший номер не закрывает файловый fallback.
 */
export async function offersFor(options: OffersOptions): Promise<Studio3dOffer[]> {
  const result: Studio3dOffer[] = [];
  const specs = operationsFor(options.version?.kind ?? options.context?.kind ?? 'start');

  for (const provider of options.providers) {
    const captured = provider.snapshot?.();
    let context = options.version ? inputContext(options.version, provider, captured)
      : structuredClone(options.context ?? START_CONTEXT);
    const available = await provider.available();

    if (available && context.nativeTaskType && options.version?.task && provider.poll && captured) {
      try {
        const response = await provider.poll([options.version.task.id], captured);
        const source = response.tasks.find((task) => task.id === options.version!.task!.id);

        if (source?.state !== 'success' || source.type !== context.nativeTaskType) {
          context = { ...context, nativeTaskType: null };
        }
      } catch {
        context = { ...context, nativeTaskType: null };
      }
    }

    if (captured && !provider.isCurrent?.(captured)) {
      context = { ...context, nativeTaskType: null };
    }

    for (const operation of provider.operations(context)) {
      const spec = specs.find((item) => item.id === operation.operation);

      if (!spec) {
        continue;
      }

      const normalized = normalizeValues(operation.fields, {});
      const quote = provider.quote(operation.operation, normalized.values, context);
      const reason = reasonFor(operation, context, provider, available);

      result.push({
        provider: provider.id,
        providerName: provider.name,
        local: provider.local,
        operation: operation.operation,
        label: spec.label,
        group: spec.group,
        fields: structuredClone(operation.fields) as Studio3dOffer['fields'],
        presets: structuredClone(operation.presets ?? []) as Studio3dOffer['presets'],
        note: operation.note ?? null,
        priceKnown: operation.priceKnown !== false && quote.total !== null && Number.isFinite(quote.total),
        available: reason === null,
        reason,
        quote,
      });
    }
  }

  return result;
}
