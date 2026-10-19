# Выбор серверного SEA для окна

Обновлённое окно читает descriptor версии 3:

```json
{ "version": 3, "kind": "sea", "root": "/physical/release", "home": "/data/grigdesk" }
```

Версии 1/2 сохраняют прежний source-запуск. В v3 пути выводятся из раскладки:
сервер — `R/server/grigdesk-server`, Node для помощников — `R/runtime/node/bin/node`.
Загрузчик проверяет executable и `--check-startup` до чтения настроек D.
SEA не получает `-p`/`--eval`, `NODE_OPTIONS` очищается. Supervisor использует явные
serverCommand/serverArgs; IPC, журнал, VPN-ворота и код перезапуска 75 сохраняются.
Встроенный интерфейс окна читается его локальной трубой и не требует web/dist в R.
Профиль «Этот компьютер» связывается с origin API из descriptor; origin самого окна
принадлежит трубе и сохраняется при перезапуске SEA. Подробнее —
[совместимость с единым приложением](sea-unified-client.md).

После установки обновлённого окна через прежний `grigdesk-ctl desktop install`:

```bash
GRIGDESK_HOME=/data/grigdesk bin/grigdesk-ctl desktop use-server /path/to/release
```

Команда проверяет marker `runtime-version=3` установленного окна, физический R,
состав пакета, допустимость D, выбор профилей и lock. При занятом lock выбранной либо
прежней D отказывает без сигналов процессу и без изменения descriptor. Прочитанный
PID/starttime сверяется через proc. Старые lock не удаляются этой командой.

Прежний descriptor сохраняется как `runtime.json.previous`, новый файл атомарно
публикуется с mode 0600. Повтор выбора того же R/D проверяет пакет и lock, сохраняя
резервную копию. Непригодный пакет, папка или профиль оставляют оба descriptor как были.
Сам AppImage эта команда не переустанавливает и миграцию данных не выполняет.
Обновление окна через `desktop install` из исходников сохраняет уже выбранный v3
и сообщает об этом. Занятый select-lock даёт понятный отказ с путём; неизвестный
владелец блокировки автоматически не снимается.

Если у прежнего source-сервера есть `profiles`, нужен явный выбор. Для стандартного
`D/profiles` можно явно передать `FACTORY_PROFILES_DIR`; нестандартный каталог должен
быть записан в `.env` папки данных, чтобы выбор сохранился при следующем запуске окна.
Каталог должен существовать. Профили не переносятся и не выбираются автоматически.

Ручной возврат выполняется при закрытом окне и остановленном выбранном сервере:
сохранить текущий `runtime.json` отдельно, затем атомарно заменить его копией
`runtime.json.previous` с правами 0600. Путь descriptor —
`$XDG_DATA_HOME/grigdesk/desktop/runtime.json`, при пустом/относительном XDG —
`~/.local/share/grigdesk/desktop/runtime.json`. Старый R и прежняя D должны сохраниться.

Проверки runtime/process/supervisor и выбора выполняются без Electron. Настоящий GUI
проверяет `tests/desktop/e2e/server-sea.e2e.mts`: копия архива, временный профиль/keyring/D,
путь `/proc/<pid>/exe` к SEA, restart75 того же R и освобождение lock после выхода.
Окружение строится по allowlist; два порта выбираются независимо.
Свежий профиль выбирает местную машину явным `--grigdesk-url`:
[контракт SEA GUI-фикстуры](../testing/sea-desktop-fixture.md).
Этот тест запускается владельцем вне песочницы, после свежей сборки desktop:

```bash
GRIGDESK_SERVER_RELEASE_DIR=/absolute/path/to/release \
GRIGDESK_ARTIFACTS_DIR=/path/to/test-artifacts NODE_TEST_MAX_RSS_MB=4096 \
  timeout 300 bash tests/desktop/e2e/isolated-session.sh \
  bash tests/run-node-tests-safe.sh --test --test-concurrency=1 \
  tests/desktop/e2e/server-sea.e2e.mts
```

Сценарий помечен нестабильным по времени. Отсутствие release или изолированной сессии —
ошибка, а не skip. Прохождение проверок на заглушках не означает прохождения GUI.
