export const QWEN_SERVICE_ENV = 'GRIGDESK_QWEN_SERVICE';
export const DEFAULT_QWEN_SERVICE = 'dashscope-intl';

// Выбор закрепляет единственный адрес получения каталога и отправки ключа.
// Неудачная авторизация не разрешает перебирать другие сервисы или регионы.
export const QWEN_SERVICES = [
  {
    value: 'dashscope-intl',
    label: 'Alibaba Model Studio — Сингапур (по умолчанию)',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  },
  {
    value: 'dashscope-china',
    label: 'Alibaba Model Studio — Китай',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  {
    value: 'dashscope-us',
    label: 'Alibaba Model Studio — США',
    baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
  },
  {
    value: 'qwencloud-intl',
    label: 'QwenCloud — Сингапур',
    baseUrl: 'https://ap-southeast-1.maas.qwencloudapi.com/compatible-mode/v1',
  },
  {
    value: 'coding-intl',
    label: 'Alibaba Coding Plan — международный',
    hint: 'Подписка Alibaba Cloud. Для Individual Plan на qwencloud.com выберите QwenCloud Token Plan.',
    baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
  },
  {
    value: 'coding-china',
    label: 'Alibaba Coding Plan — Китай',
    hint: 'Подписка Alibaba Cloud. Для Individual Plan на qwencloud.com выберите QwenCloud Token Plan.',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
  },
  {
    value: 'qwencloud-token',
    label: 'QwenCloud Token Plan — Сингапур',
    hint: 'Individual Plan и Team Plan на qwencloud.com. Используйте ключ из кабинета QwenCloud.',
    baseUrl: 'https://token-plan.maas.qwencloudapi.com/compatible-mode/v1',
  },
  {
    value: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
] as const;

/**
 * Без выбора используется прежний сервис переменной DASHSCOPE_API_KEY.
 * Неизвестное сохранённое значение останавливает discovery до передачи секрета.
 */
export function selectedQwenService() {
  const id = process.env[QWEN_SERVICE_ENV] || DEFAULT_QWEN_SERVICE;
  const service = QWEN_SERVICES.find((entry) => entry.value === id);

  if (!service) {
    throw new Error('Qwen: выберите сервис API в карточке исполнителя');
  }

  return service;
}

/**
 * Общая форма доступа сохраняет сервис вместе с ключом без отдельного мастера.
 * Значение по умолчанию объясняется подписью, даже пока переменная ещё не записана.
 */
export function qwenServiceCredential() {
  return {
    env: QWEN_SERVICE_ENV,
    kind: 'choice',
    label: 'Сервис API и регион',
    hint: 'Выберите сервис, выдавший ключ. Без выбора используется Alibaba Model Studio в Сингапуре.',
    options: QWEN_SERVICES.map((service) => ({
      value: service.value,
      label: service.label,
      ...'hint' in service ? { hint: service.hint } : {},
    })),
  };
}
