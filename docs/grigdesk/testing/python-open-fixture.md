# Подмена Python os.open влияет на очистку временного каталога

`module.os` импортированного worker ссылается на общий Python-модуль `os`.
Замена `module.os.open` меняет его также для `tempfile` и `shutil`. В тесте прав
status-файла spy без `dir_fd` ломал выход из `TemporaryDirectory` на Python 3.12,
хотя проверяемая атомарная запись уже успешно завершилась.

Тест `speech-model-jobs.test.js` восстанавливает `os.open` и `os.replace` сразу
после `atomic_write`, до очистки временного каталога. Снятые spy-показания
сохраняются отдельно и по-прежнему проверяют 0600 и O_EXCL.
