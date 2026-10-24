import type { PluginInstallErrorInfo } from '../../../../shared/plugins/pluginInstallContracts.ts';

export class PluginInstallError extends Error {
  readonly code: string;
  readonly statusCode: number;

  /**
   * Ошибка несёт безопасный код и HTTP статус, а не stderr команды.
   * Публичная форма сохраняет этот текст при передаче в браузер.
   */
  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = 'PluginInstallError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const PLUGIN_INSTALL_ERRORS: Record<string, { status: number; message: string }> = {
  source_url_invalid: {
    status: 400,
    message: "Адрес не подходит. Поддерживаются https://, ssh://, git@хост:путь и "
      + "file:///абсолютный/путь; секреты в адресе и логин в HTTPS не допускаются.",
  },
  source_kind_unknown: {
    status: 400,
    message: "Неизвестный вид источника плагина.",
  },
  source_unavailable: {
    status: 502,
    message: "Репозиторий не найден или нет доступа. Проверьте адрес и вход git на этой машине: для "
      + "GitHub по https — gh auth login и gh auth setup-git, для ssh — ключ без запроса пароля.",
  },
  source_unreachable: {
    status: 502,
    message: "Хост источника недоступен. Проверьте сеть и адрес.",
  },
  source_timeout: {
    status: 504,
    message: "Источник не ответил вовремя.",
  },
  source_failed: {
    status: 502,
    message: "git завершился с ошибкой. Подробности — в журнале сервера.",
  },
  source_no_versions: {
    status: 422,
    message: "В источнике нет тегов вида vX.Y.Z.",
  },
  version_not_found: {
    status: 404,
    message: "Такой версии в источнике нет.",
  },
  version_installed: {
    status: 409,
    message: "Эта версия уже установлена.",
  },
  checkout_mismatch: {
    status: 409,
    message: "Тег сдвинулся во время загрузки. Начните установку заново.",
  },
  manifest_missing: {
    status: 422,
    message: "В корне репозитория нет plugin.json.",
  },
  manifest_invalid: {
    status: 422,
    message: "plugin.json не читается: нужен JSON-объект не больше 64 КиБ.",
  },
  id_invalid: {
    status: 422,
    message: "id в plugin.json: строчные латинские буквы, цифры, «-» и «_», до 41 символа, первый — "
      + "буква или цифра.",
  },
  id_reserved: {
    status: 422,
    message: "id совпадает со встроенным плагином GrigDesk.",
  },
  id_mismatch: {
    status: 422,
    message: "id в новой версии отличается от установленного плагина.",
  },
  api_unsupported: {
    status: 422,
    message: "Плагин рассчитан на другую версию контракта (api). Этот GrigDesk поддерживает api 1 и 2.",
  },
  version_invalid: {
    status: 422,
    message: "version в plugin.json должна быть вида X.Y.Z.",
  },
  version_mismatch: {
    status: 422,
    message: "version в plugin.json не совпадает с тегом.",
  },
  grigdesk_too_old: {
    status: 422,
    message: "Плагину нужна более новая версия GrigDesk.",
  },
  web_invalid: {
    status: 422,
    message: "Поле web должно указывать на подпапку плагина с index.html.",
  },
  symlink_forbidden: {
    status: 422,
    message: "В пакете есть символическая ссылка.",
  },
  submodules_forbidden: {
    status: 422,
    message: "Подмодули git не поддерживаются.",
  },
  package_too_large: {
    status: 422,
    message: "Пакет слишком большой: больше 5000 файлов или 50 МиБ без .git.",
  },
  npm_dir_invalid: {
    status: 422,
    message: "install.npm должен перечислять подпапки плагина с package.json.",
  },
  lockfile_missing: {
    status: 422,
    message: "Для зависимостей нужен package-lock.json.",
  },
  dependencies_failed: {
    status: 422,
    message: "npm ci завершился с ошибкой. Подробности — в журнале сервера.",
  },
  install_busy: {
    status: 409,
    message: "Уже идёт другая установка, обновление или откат.",
  },
  service_closed: {
    status: 503,
    message: "Сервис установки завершает работу. Повторите после запуска GrigDesk.",
  },
  job_not_found: {
    status: 404,
    message: "Задание установки не найдено.",
  },
  job_not_ready: {
    status: 409,
    message: "Задание ещё не готово к установке.",
  },
  plugin_busy: {
    status: 409,
    message: "Плагин сейчас занят.",
  },
  local_changes: {
    status: 409,
    message: "Установленная копия отличается от версии из источника: в ней ручные правки.",
  },
  not_managed: {
    status: 404,
    message: "Плагин установлен вручную и не связан с источником.",
  },
  no_previous: {
    status: 409,
    message: "Прежней версии для отката нет.",
  },
  apply_failed: {
    status: 500,
    message: "Замена не выполнена; прежняя версия проверена и восстановлена.",
  },
  recovery_required: {
    status: 503,
    message: "Состояние установки требует восстановления. Копии сохранены; новые операции заблокированы.",
  },
  state_invalid: {
    status: 503,
    message: "Состояние установки не читается или несовместимо. Файлы сохранены для разбора.",
  },
  preview_stale: {
    status: 409,
    message: "Пакет или установленная версия изменились после проверки. Подготовьте установку заново.",
  },
  plugin_stop_required: {
    status: 409,
    message: "Плагин не умеет приостанавливать работу. Выключите его и перезапустите GrigDesk перед "
      + "заменой.",
  },
  previous_modified: {
    status: 409,
    message: "Прежняя копия изменена или повреждена; автоматический откат недоступен.",
  },
  package_unsupported: {
    status: 422,
    message: "Пакет использует неподдерживаемую конфигурацию git или npm.",
  },
  workspace_limit: {
    status: 422,
    message: "Подготовка превысила предел рабочего каталога или свободного места.",
  },
  command_output_limit: {
    status: 422,
    message: "Вывод команды превысил допустимый размер; неполный результат не используется.",
  },
  cancelled: {
    status: 409,
    message: "Установка отменена.",
  },
  interrupted: {
    status: 409,
    message: "Сервер перезапустился во время установки. Начните заново.",
  },
  internal: {
    status: 500,
    message: "Внутренняя ошибка установки. Подробности — в журнале сервера.",
  },
};

/**
 * Машинный код выбирает только заранее объявленный безопасный текст.
 * Дополнение используется доверенным вызывающим и не содержит вывода команды.
 */
export function installError(code: string, detail?: string): PluginInstallError {
  const entry = PLUGIN_INSTALL_ERRORS[code];

  if (!Object.hasOwn(PLUGIN_INSTALL_ERRORS, code) || !entry) {
    throw new TypeError('Неизвестный код ошибки установки');
  }

  const message = detail ? `${entry.message.replace(/\.$/u, '')}: ${detail}` : entry.message;

  return new PluginInstallError(code, message, entry.status);
}

/**
 * Публичная форма сохраняет известный отказ и скрывает стороннюю диагностику.
 * Неизвестные значения никогда не превращаются в текст ошибки для браузера.
 */
export function errorInfo(error: unknown): PluginInstallErrorInfo {
  const safe = error instanceof PluginInstallError ? error : installError('internal');

  return {
    code: safe.code,
    message: safe.message,
  };
}
