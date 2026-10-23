package local.grigdesk.client.shell;

public final class ClientFailure {
  private ClientFailure() {
  }

  /**
   * CompletableFuture оборачивает нативный отказ в ExecutionException.
   * Разворачивается только служебная оболочка, причина камеры/биометрии сохраняется.
   */
  public static Throwable unwrap(Throwable error) {
    while ((error instanceof java.util.concurrent.ExecutionException
      || error instanceof java.util.concurrent.CompletionException) && error.getCause() != null) {
      error = error.getCause();
    }

    return error;
  }

  /**
   * Ожидание нативного диалога ограничено тремя минутами на сетевом работнике.
   * Исходное исключение возвращается вызывающему коду, прерывание не теряется.
   */
  public static <T> T await(java.util.concurrent.CompletableFuture<T> future) throws Exception {
    try {
      return future.get(3, java.util.concurrent.TimeUnit.MINUTES);
    } catch (java.util.concurrent.ExecutionException error) {
      Throwable cause = unwrap(error);

      if (cause instanceof Exception) {
        throw (Exception) cause;
      }

      throw new IllegalStateException("Не удалось завершить нативное действие.", cause);
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw error;
    }
  }

  /**
   * Коды протокола переводятся в действия человека без адреса и внутренних исключений.
   * Неизвестный отказ подсказывает проверить включение отдельного клиентского входа.
   */
  public static String message(String code, ShellLocale locale) {
    return locale == null ? message(code) : locale.text("native." + code, locale.text("native.offline"));
  }

  public static String message(String code) {
    switch (code) {
      case "unpaired":
        return "Нужна повторная привязка устройства. Получите новый QR в разделе «Доступ к серверу».";
      case "device_unknown":
        return "Устройство не найдено. Получите новый QR и привяжите его заново.";
      case "device_scope_forbidden":
        return "Отзовите старую привязку и подключите актуальное приложение новым QR.";
      case "relay_upgrade_required":
        return "Обновите ретранслятор сервера для нового приложения.";
      case "relay_pin_mismatch":
        return "Сертификат ретранслятора не совпал: сеть подменяет соединение или ретранслятор "
          + "пересоздан. Дома телефон подключится напрямую; иначе получите новый QR.";
      case "relay_unauthorized":
        return "Ретранслятор отклонил ключ телефона. Получите новый QR в разделе «Доступ к серверу».";
      case "server_upgrade_required":
        return "Обновите GrigDesk на машине.";
      case "client_upgrade_required":
        return "Обновите приложение GrigDesk.";
      case "identityMismatch":
        return "Это не тот сервер.";
      case "locked":
        return "Разблокируйте приложение.";
      case "invalid_pairing":
        return "Строка привязки повреждена. Получите новый код на машине.";
      case "unsupported_address":
        return "Этот тип адреса пока не поддерживается приложением.";
      case "pair_code_invalid":
        return "Код привязки недействителен или истёк. Получите новый код.";
      case "pair_locked":
        return "Слишком много попыток привязки. Повторите позже.";
      case "device_revoked":
        return "Доступ этого устройства отозван. Привяжите его заново.";
      default:
        return "Сервер недоступен. Проверьте связь и способы подключения в разделе «Доступ к серверу».";
    }
  }
}
