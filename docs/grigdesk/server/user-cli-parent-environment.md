# Исходное окружение внешних CLI

Ранние launcher-ы сохраняют исходные PATH и обе формы npm prefix перед собственными изменениями.
Приватный `GRIGDESK_USER_CLI_PARENT_V1` содержит JSON version=1, path, npmPrefixLower и npmPrefixUpper;
null означает отсутствие переменной. Полный env и ключи доступа в marker не входят, предел — 64 КиБ.
Повторный launcher сохраняет валидный исходный marker; повреждённый marker не заменяется новым.

Сохранение выполняется в desktop buildServerEnv, packagedChildEnvironment (оба SEA launch-пути)
и startDataHome. Это синхронные операции без shell и файлового discovery; прежние значения managed
PATH/prefix остаются такими же. Marker предназначен только для служебного bootstrap, не для API.

`providerInstall/userCliEnvironment.ts` отдельно проверяет интерактивный и login Bash в HOME.
Startup exports возвращаются приватным NUL-протоколом, шум stdout не считается ответом. Значения
proxy/CA/npmrc и пользовательские exports сохраняются, служебные GRIGDESK-переменные и loaders
отсеиваются. Файлы протокола временные, приватные, ограничены 256 КиБ и удаляются в finally.
Alias/function для команд, несовпадение выбора CLI/runtime или prefix env между формами, timeout,
невалидный marker и неподдержанная оболочка дают явный отказ. Этот resolver не пишет rc.

Проверки: user-cli-parent-environment и user-cli-environment, включая реальные Bash startup-файлы
изолированного HOME. Самостоятельная проверка окружения не означает завершённую установку CLI.
