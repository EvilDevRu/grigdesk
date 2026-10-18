# Подготовка и публикация пользовательского пакета

`server/src/lib/pluginInstall/service.ts` объединяет источники, проверку пакета, npm,
устойчивый журнал и filesystem resolver. Модуль плагинов использует его через
installer port и HTTP; boot подключён [отдельно](plugin-install-boot.md), а
установка из каталога описана в [контракте интерфейса](../web/plugin-install-ui.md).
Ниже описаны гарантии,
проверенные изолированными service и Fastify fixtures.

## Владение подготовкой

Перед работой сервис берёт kernel lock `.grigdesk-install/owner.lock`. Файл замка
сохраняется после закрытия. Второй instance или процесс с тем же каталогом получает
безопасный отказ и не меняет JSON. Служебные roots создаются после успешного чтения
состояния: missing archive parent не должен блокировать уже начатую публикацию.

Install и update занимают один admission slot синхронно, до внешних await. Подготовка
возвращает running job, затем сохраняет ready и reviewToken. Ready занимает slot до
явного apply/cancel. Проценты живут в памяти; job id/generation защищают следующее
задание от отложенных progress/stage callbacks прежнего.

Все production Git/npm команды используют owned runner. Identity сохраняется до
разрешения executable; отсутствие устойчивого ACK не допускает запуск Git. Close
закрывает новый допуск, ждёт текущую apply/rollback и допущенные записи running,
сливает выполняющиеся и ожидающие read-команды, callbacks и registry writes перед
освобождением замка. Неустойчивый исход удерживает lock, даже если workers уже завершены. До двух source reads могут выполняться одновременно.

Один staging budget охватывает package, `.git`, npm cache и dependencies. Общий
deadline подготовки — 20 минут; между npmDirs проверяются отмена, размер и свободное
место. Ошибка записи блокирует новые операции и не разрешает cleanup staging.

## Проверенная публикация

Apply требует runtime binding, lease и сохранённый reviewToken. Отказ lease
сохраняет ready и bytes candidate. Подготовленный npm payload проверяется отдельно
от исходного пакета: generated directories допускаются только по manifest selection,
повторный npm не запускается.

Чистый managed current становится previous с полным source/version/npmDirs/digest
snapshot. Ручные tracked, новые и ignored правки дают local_changes. Force сохраняет
их в replaced и оставляет прежний previous. Неизвестные правки previous блокируют
как rollback, так и следующий update.

Публикация record и done выполняется общим filesystem resolver. Known done с тем же
reviewToken возвращается без новых rename/revision/refresh, в том числе из
completedJobs. Для загруженного runtime restart flag устанавливается до refresh;
installed lease сохраняет остановку до перезапуска.

Rollback принимает requestId, expectedRevision и expectedPreviousDigest, проверяет
обе копии и возвращает полный snapshot предыдущей версии, включая installedAt и
npmDirs. Намеренное обратное переключение использует новый requestId и свежую
revision. Receipt публикуется вместе с done.

CheckUpdates сохраняет безопасный checkError одного недоступного источника отдельно
от результатов остальных. Прежний latest удерживается только для того же source;
kind также участвует в source identity. Describe выполняет локальные проверки с concurrency 2 и cache на 2 секунды,
не запускает listing источника. Свои мутации сбрасывают cache. Проверка обновлений
использует single-flight и CAS source/revision, поэтому поздняя сеть не меняет новый record.

## Startup recovery и известные исходы

Новый instance валидирует state целиком, завершает workers по подтверждённой identity,
затем разрешает intent. Native process-crash fixtures проверяют recovery после commit
до ответа и rollback до commit: receipt создаётся из сохранённого intent. Running/ready
без intent становятся interrupted только после drain. Applying без согласованного
intent/outcome блокирует id; повреждённый state блокирует все user plugins.

CompletedJobs удерживает 32 terminal summaries. Job by id возвращает A даже при
активном B; повтор подтверждённого apply не меняет B. Вытесненный outcome даёт
job_not_found без новой мутации. Ошибка refresh после commit оставляет done и архив,
а безопасное предупреждение доступно отдельно; повтор refresh не создаёт transaction.

Lifecycle модуля и session-only HTTP проверены
[отдельно](plugin-install-runtime.md). Boot проверен [отдельно](plugin-install-boot.md).
Границы process-crash файловой транзакции описаны в
[документе resolver](user-plugin-apply-recovery.md). Остановка процесса проверена;
исчезновение питания или повреждение диска не считаются проверенной гарантией.
