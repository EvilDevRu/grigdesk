# Три описи тестов браузера

tests/run-all.sh запускает browser-*.test.mts для desktop/server/web,
factory-browser-*.test.mts и open-stand.test.mts отдельной safe-группой.
JS-компонентный тест и chat wiring уже входят в пакетные glob. Engine contract
находится штатным discovery; Electron smoke выполняется отдельно.

Исполнение не заменяет проверку типов. server/tsconfig.tests.json включает узкий
glob desktop/browser-*.test.mts; web test project включает browserNative.d.ts.
Строгий тип fake WebContents требует явно отделять EventEmitter-двойник от настоящего
Electron WebContents. Production интерфейс ради двойника не ослабляется.

Новые JS-файлы попадают в migration-inventory-baseline.json. Добавляются только
свои пути, без перезаписи посторонних записей. Тест suite-wiring также считает
потребителей run-all; новая группа увеличивает собственную часть описи на один.
При расхождении сначала сверяют реальные ступени, затем ожидаемое число.
