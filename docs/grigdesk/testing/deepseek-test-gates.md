# Проверки автономного DeepSeek

`npm --prefix deepseek test` запускает непосредственные unit-файлы `tests/deepseek/*.test.mts`
через сторож памяти. `test:sea` отдельно запускает все файлы `tests/deepseek/sea/*.test.mts`,
последовательно; имя нового теста не обязано содержать «настоящ». `typecheck` проверяет
исходники, scripts и тесты пакета. `verify -- --binary <ELF>` всегда проверяет полные хэши
готовой поставки и не заменяет transport/parity тесты.

Общий `tests/run-all.sh` последовательно подготавливает A/B и admitted fixtures до наборов,
чтобы холодные сборки не пересекались с unit-файлами, требующими много памяти. Путь основного
проверенного ELF, выбранный cache и reusable payload передаются всем наборам. Package unit,
SEA и host compiled parity имеют отдельные ступени. Только fixtures перехода дополнительно
получают legacy Node22 generation. Её отсутствующие зависимости
[автоматически готовятся в отдельном кэше](deepseek-legacy-preflight.md).
Отказ любой ступени сохраняет ошибочный итог прогона.

Host-прогоны GLM требуют работоспособного системного sandbox backend. Release CI
устанавливает bubblewrap и проверяет настоящий mount/PID-профиль до подготовки ELF;
успешная metadata-проба не доказывает, что sandbox доступен при boot GLM gate.

Проверка Factory coverage передаёт выбранные primary/failover явно, как dispatcher.
Смена сборки резервного DeepSeek обновляет host snapshot; отсутствие резерва сохраняет
доступный Claude, а цепочка только из недоступного DeepSeek остаётся закрытой.

Source-sync gate `server/scripts/verifyDeepSeekCandidate.mts --vendor-dir <каталог>` строит
ELF именно из переданного vendor, затем проверяет пакет и host parity на нём. Builder
запрещает сочетание `--vendor-dir` и `--payload`: архив прежней сборки не доказывает новый
candidate. Pinned Node и dependencies должны быть подготовлены заранее; отдельный cache
можно передать через `GRIGDESK_DEEPSEEK_NODE_CACHE`.
Каждая ступень сохраняет stdout/stderr в отдельный private отчёт под `gates/reports-*`.
При отказе CLI печатает путь к нему: внешний source-sync процесс иначе показывает
только stderr, теряя причину вложенного TAP-отказа. Временный ELF после gate удаляется.

Поведенческий `suite-wiring` выполняет копию реального `run-all.sh` в чистом стенде
без `bin/deepseek`. Дорогие наборы заменены наблюдателями, которые вызывают настоящий
helper выбора runtime. Тест проверяет candidate во всех ступенях и во вложенном source gate,
а также отказ отсутствующего explicit candidate до запуска наборов. Это проверка проводки,
она не заменяет полный прогон и настоящий source-sync build/transport gate.
Потребители в стенде не наследуют binary/cache/payload override от внешнего теста:
его получает только subprocess настоящего producer helper. Наблюдатели требуют параметры,
экспортированные самим `run-all`; producer вызывается ровно один раз с `--prepare-suite`.

Compiled сценарии используют ELF для web/ACP и выбранный cache. Проверки closure дополнительно
импортируют plugin и native addon через bundled worker Node; loader recorder вызывается явно,
так как launcher запрещает наследование `NODE_OPTIONS`. Этот отдельный closure probe не
выдаётся за запуск ELF. Unit metadata/transport doubles не служат доказательством parity.
Legacy helpers остаются только для исходных fixtures перехода и integrity старого формата.

`GRIGDESK_TEST_DEEPSEEK_ROOT` задаёт корень тестовых артефактов. Общий прогон помещает туда
остальные fixtures через `GRIGDESK_ARTIFACTS_DIR`, сохраняя pinned Node cache отдельно через
`GRIGDESK_DEEPSEEK_NODE_CACHE`. Это параметры тестовой подготовки, а не default приложения. Diagnostic отчёты и
fixtures берут корень через `deepSeekTestArtifactsRoot()`; родитель отчёта создаётся самим
тестом. Наличие каталога от предыдущего ручного запуска не является условием теста.
После прерывания helper удаляет брошенные private source-копии под своим build lock;
готовый ELF и его runtime integrity при этом продолжают проходить полную проверку.
