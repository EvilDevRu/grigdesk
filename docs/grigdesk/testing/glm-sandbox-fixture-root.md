# Фикстура GLM и приватный tmp песочницы

Режим песочницы Harness `workspace-write` монтирует приватный tmpfs поверх host `/tmp`,
затем возвращает внутрь только рабочую папку. Файл политики GLM лежит в home запуска,
отдельно от project cwd. Если реальная фикстура размещает весь home в системном tmp,
hook внутри bubblewrap не видит `glm-policy.json` и блокирует prompt.

`glmBinaryFixture` создаёт home и policy под `deepSeekTestArtifactsRoot()`, вне системного
tmp. Это сохраняет настоящие sandbox и fail-closed проверку политики. Вложенная рабочая
папка остаётся единственным разрешённым местом записи инструментов.

Та же граница действует для изолированного consumer в `deepseek-boundary.test.js`:
копия server/shared, home и policy размещаются через `createGlmBinaryFixtureRoot`.
Native gate проверяет helper до prompt, поэтому скрытый tmpfs файл останавливает запуск
ещё до модели. Проверка автономности по-прежнему исключает Harness source и runtime tree
из копии consumer; перенос стенда не расширяет sandbox.

Проверка размещения не запускает metadata double и не заменяет parity на ELF.
Адресный прогон с TMPDIR внутри артефактов сам по себе не воспроизводит проблему
полного прогона с системным `/tmp`; для приёмки нужен также внешний полный набор.
