# Память GLM при замене бинарника

Стабильный binary home GLM ключуется только server-owned chatKey. Compatibility служит
допуску выпуска; packageId определяет поставку и кэши. Эти отпечатки не входят в профиль
прав и имя home. На настоящей паре ELF с разными packageId и одинаковым compatibility
последовательность A→B→A продолжает одну sessionId, а loopback API получает прежние сообщения.

Перед resume `inspectSessionJournal` проверяет наличие и самый новый canonical номер
журнала в home этого чата и cwd. Отсутствие даёт `glm_session_missing` без запуска модели.
Если номер не входит в `journal.read`, GLM создаёт новую сессию с заметкой о несовместимости.
Её CAS завершается до model call. Тест с реальным сжатым журналом под именем v99 проверяет
неизменность прежних bytes, сохранение ленты и передачу pendingSeed в новую память.

GLM и DeepSeek используют одну реализацию prepared-runtime scope и разные WeakMap.
Пустой замороженный handle одного провайдера отвергается другим. Тот же handle проходит
общую подготовку чата, securityProfile и run; при замене выбранного ELF после CAS GLM
возвращает `glm_runtime_changed` до prompt, без автоматического повтора и изменения binding.
Следующий явный пользовательский ход может продолжить прежнюю сессию на новом ELF.

`ensureHarnessChatHome` создаёт закрытый marker `{format:1,provider}` без перезаписи
существующего файла и проверяет его принадлежность до запуска. Корни GLM и DeepSeek
раздельны. Переходная embedded-ветка сохраняет прежнюю адресацию до удаления legacy.

Поведение проверяет `tests/server/glm-binary-session-continuity.test.js`; запреты смены
ключа, режима, cwd и флагов остаются в `tests/server/glm-session.test.js`.
