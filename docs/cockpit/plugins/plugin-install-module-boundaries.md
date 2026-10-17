# Границы модулей установки

`PluginInstallService` владеет admission, подготовкой, durable состоянием и привязкой
runtime. Apply и rollback сохраняют собственные preflight, создание intent, резервирование
`operation`, обработку отказа до эффектов и `finally`.

Общий `publishReplacement` в `server/src/lib/pluginInstall/service.ts` последовательно
вызывает filesystem resolver, перечитывает state, сбрасывает описания, публикует restart
для загруженного плагина, завершает lease и обновляет reserved/health. Только completed
обновляет каталог runtime; результат возвращается копией durable job.

Оба вызывающих метода используют `return await`: `operation` остаётся занятой до окончания
lease и refresh. Ошибка refresh после commit сохраняет done и отдельное предупреждение
каталога. Повтор подтверждённого apply или rollback receipt возвращается до нового lease.

Общие значения DTO находятся в `shared/plugins/pluginInstallValues.ts`: UUID, SHA, digest,
канонический UTC timestamp, ограниченный текст и списки kinds/status/stages. Их guards
не создают ошибок и не зависят от среды. Browser decoder сохраняет собственный
`PluginInstallProtocolError`, disk validator — `state_invalid`.

`stateValidation.ts` проверяет полную форму и связи журнала, отвергает лишние поля и
требует известный код ошибки. `pluginInstallApi.ts` заново строит DTO, отбрасывает лишнее,
принимает корректный по форме новый код и строже проверяет status/stage/percent. Политики
URL, версии, error.message, backupRef и npmDirs остаются в адаптерах. Persisted plugin id
по-прежнему использует `PLUGIN_ID_RE` из manifest границы.

Prepared-статусы job (`ready`, `applying`, `done`) требуют полного preview. Отдельный
список в validatePrepared допускает `recovery_required`, чтобы blocked замена сохраняла
свои копии и запись подготовки для восстановления.
