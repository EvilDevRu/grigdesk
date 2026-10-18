// Приватный stdio-мост связывает ACP SDK с исходным settings controller.
// Он не регистрирует инструменты модели и не дублирует проверку схемы или CAS.

import { RequestError } from '@agentclientprotocol/sdk';

export const name = 'grigdesk-acp-settings';
export const inject = ['settingsController', 'settings'];

/**
 * SDK сохраняет бизнес-причину controller через штатный RequestError.
 * Этот ответ остаётся приватным stdio-протоколом; stack и credentials не добавляются.
 */
async function delegate(operation) {
  try {
    return await operation();
  } catch (error) {
    throw RequestError.internalError({ kind: error.code || 'settings/internal' }, error.message);
  }
}

/**
 * Parser ограничивает только RPC envelope; значения проверяет upstream controller.
 * SDK отвергает неверные params до вызова метода и не выводит их в stdout.
 */
function parameters(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Некорректный запрос private settings');
  }

  return value;
}

/**
 * Сервис захватывается при injection и остаётся тем же владельцем namespaces.
 * Обе операции доступны host-клиенту до любой рабочей session/prompt.
 */
export function apply(ctx) {
  const controller = ctx.settingsController;

  ctx.provide('grigdeskAcpSettingsBridge', {
    capabilities: { 'grigdesk.settings': { contract: 1 } },
    configure(app) {
      app.onRequest('_grigdesk/settings/describe', parameters, () => delegate(() => controller.describe()));
      app.onRequest('_grigdesk/settings/mutate', parameters, async ({ params }) => {
        if (
          typeof params.ns !== 'string' || !Array.isArray(params.ops) ||
          !Number.isSafeInteger(params.expectedRevision)
        ) {
          throw new Error('Некорректный запрос private settings mutation');
        }

        return delegate(() => controller.mutate(params.ns, params.ops, params.expectedRevision));
      });
    },
  });
}
