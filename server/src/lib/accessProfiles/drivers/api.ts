import type { AccessCapability } from '../types.ts';
import { accessError } from '../service.ts';
import { fetchDeepSeekBalance } from '../../deepseek/balance.ts';
import { callZai } from '../../glm/usage.ts';

/**
 * API-ключ проверяется безопасным чтением баланса, без модельного хода.
 * Отсутствие квоты отличается от отказа авторизации и не запрещает сохранение.
 */
export const deepSeekAccess: AccessCapability = {
  envKeys: ['DEEPSEEK_API_KEY'],
  methods: [{
    id: 'api-key',
    kind: 'api-key',
    label: 'API',
    fields: [{
      id: 'DEEPSEEK_API_KEY',
      kind: 'secret',
      label: 'API-ключ',
    }],
    isolated: true,
  }],
  legacy: (env) => env.DEEPSEEK_API_KEY
    ? [{
      methodId: 'api-key',
      env: { DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY },
      active: true,
    }] : [],
  /**
   * Баланс подтверждает ключ, но не раскрывает идентичность аккаунта.
   * Эта неизвестность сохраняется для отдельного подтверждения повторного входа.
   */
  async verify(input, context) {
    const key = input.DEEPSEEK_API_KEY;

    if (typeof key !== 'string' || !key.trim() || /[\r\n\0]/u.test(key)) {
      throw accessError(400, 'invalid_key', 'Укажите API-ключ.');
    }

    const result = await fetchDeepSeekBalance({ apiKey: key.trim(), fetchImpl: context.fetchImpl });

    if (!result.ok) {
      throw accessError(400, result.state, result.message);
    }

    return { env: { DEEPSEEK_API_KEY: key.trim() }, evidence: { kind: 'unknown' } };
  },
};

/**
 * Каждый способ Z.ai хранит лишь собственный ключ и режим.
 * Номер клиента остаётся приватным evidence, а не отпечатком секрета или полем DTO.
 */
export const glmAccess: AccessCapability = {
  envKeys: ['GRIGDESK_GLM_API_MODE', 'ZAI_API_KEY', 'ZAI_CODING_API_KEY'],
  methods: [
    {
      id: 'api',
      kind: 'api-key',
      mode: 'api',
      label: 'Обычный API',
      isolated: true,
      fields: [{
        id: 'ZAI_API_KEY',
        kind: 'secret',
        label: 'API-ключ',
      }],
    },
    {
      id: 'coding-plan',
      kind: 'api-key',
      mode: 'coding-plan',
      label: 'Coding Plan',
      isolated: true,
      fields: [{
        id: 'ZAI_CODING_API_KEY',
        kind: 'secret',
        label: 'API-ключ Coding Plan',
      }],
    },
  ],
  legacy(env) {
    return this.methods.flatMap((method) => {
      const key = method.fields[0]!.id;

      return env[key] ? [{
        methodId: method.id,
        env: { [key]: env[key], GRIGDESK_GLM_API_MODE: method.mode },
        active: env.GRIGDESK_GLM_API_MODE === method.mode,
      }] : [];
    });
  },
  /**
   * Режим определяет маршрут и единственный допустимый ключ.
   * Подтверждённый номер клиента используется только для приватного сравнения аккаунтов.
   */
  async verify(input, context) {
    const field = context.method.fields[0]!.id;
    const key = input[field];

    if (typeof key !== 'string' || !key.trim() || /[\r\n\0]/u.test(key)) {
      throw accessError(400, 'invalid_key', 'Укажите ключ выбранного режима.');
    }

    const api = context.method.mode === 'api';
    const response = await callZai(context.fetchImpl, key.trim(), api
      ? 'biz/customerService/zaiUserInfo' : 'monitor/usage/quota/limit');

    if (!response.ok) {
      throw accessError(400, response.state, response.message);
    }

    const customer = response.data.customerNumber;

    if (api && (typeof customer !== 'string' || !customer)) {
      throw accessError(400, 'unavailable', 'Кабинет не подтвердил аккаунт.');
    }

    return {
      env: { [field]: key.trim(), GRIGDESK_GLM_API_MODE: context.method.mode },
      evidence: typeof customer === 'string'
        ? { kind: 'known', account: customer } : { kind: 'unknown' },
    };
  },
};
