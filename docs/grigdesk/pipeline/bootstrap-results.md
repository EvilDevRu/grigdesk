# Результат отдельной разведки и ответ человеку

Отдельный bootstrap запускает один агентный узел `scout`, `runKey=SCOUT`, с политикой
`state-only`. Основной маршрут закреплён человеком. Успешная разведка подтверждает
допустимость этого pin и не выбирает другой маршрут сама. `bootstrap: skip` не создаёт
фиктивного запуска или checkpoint. Иная topology/action отклоняется до модели.

## Успех и находки

Общий `stage-result` принимает `done` без вердикта либо с `deferred`. Блокирующий done
остаётся запрещён. Оба транспорта статуса используют прежние validator и terminal CAS.
Dispatcher связывает результат с действительно запущенными run/epoch и выполняет
workspace guard после каждого исполнения, включая молчание и исчерпание retries.

Immutable `artifacts/bootstrap.json` schema 2 сохраняет прежнюю identity, result=done,
runId и transitionHash, добавляя epoch от 1 и полный canonical verdict либо null.
Mode=0400, одна ссылка, без token/capability. Публикация под task lock: повторная проверка
identity, fsync, rename, синхронизация каталога. Resume читает checkpoint без модели.

TransitionHash schema 2 — SHA-256 UTF-8 canonical JSON: sort_keys, indent=2,
ensure_ascii=false, завершающий newline. Envelope содержит schema/catalogHash/phase/node/
outcome/action/retry/escalationPolicy. Успешный emitter сохраняет historical байты
и не добавляет failureOwner:null. Schema 1 не переписывается: проверяются identity,
форма hash и pinned семантика. Версия старого emitter не была закреплена, поэтому
нынешняя сериализация не доказывает historical hash. Epoch/verdict из SCOUT.active не восстанавливают.

Stage events остаются schema 1. Общий findings reader под одним task lock объединяет
проверенные checkpoint и stage ledger, не создавая основной cursor:

| Источник | source | Sequence |
| --- | --- | --- |
| Основной маршрут | `{phase:"route"}` | Прежние числовые значения |
| Bootstrap | `{phase:"bootstrap",recordHash,runId,epoch}` | Все три поля sequence равны null |

При bootstrap-находках findings projection имеет schema 2; без них сохраняет schema 1,
включая старую форму без deferred. Ключ — phase/sourceNode/id. Основной scout не закрывает
одноимённую bootstrap-находку. Bootstrap идёт по id перед route-находками. Loop сохраняет
schema/source; freshness bootstrap равна `(0,0,0)`, route — `(1,lastSeenSequence,openedSequence)`.
Context hook получает фазу явно: основной scout не исключается из ledger по одному имени.

## Выгрузка и приёмка

`factory TASK findings-export --profile <profile> --attempt ATTEMPT --format json|markdown`
читает полную проекцию, включая terminal, без профиля, runner, provisioning или lifecycle.
JSON содержит task/profile/attempt, bootstrap hash, stage ledger head и полный findings.
Штатный Markdown writer использует тот же renderer: 0 с числом находок — успех,
9 — проверенный пустой хвост с удалением старой проекции, прочие коды — ошибка.
Запись атомарна; ошибка побочной проекции после terminal не переигрывает завершение.

`GET /api/tasks/:id/findings?profile=PROFILE&attempt=ATTEMPT` проверяет текущую trusted
identity и вызывает CLI. UI показывает deferred с источником. Ошибка чтения удерживает
кнопку принятия до успешного чтения; проверенный пустой список допустим. CLI принятия
ворот тоже проверяет доверенную projection. `t<TASK>.deferred.md` не является authority.

## Вопрос до основного курсора

Failed, skipped и host-generated exhausted используют закреплённый transition-bootstrap.
Для failed typed owner выбирает onFailure с fallback на on.failed; failure-owner запрещён
у других исходов. Поддержаны done→escalate и неуспешные stop:human.

`bootstrap-results/event.<sequence>.<hash>.json` — отдельная append-only цепочка:
visit → stop → decision → новый visit → completed. Immutable record связывает
task/profile/attempt/pin, phase, node, visitId, predecessor и timestamp. Stop хранит outcome,
reason, canonical verdict, список реальных run/epoch и transitionHash. При exhausted
все исполнения имеют result=null: молчание не объявляется committed. Completed ссылается
на hash успешного checkpoint. Crash после checkpoint до completed восстанавливает только
completed без новой модели и без перезаписи checkpoint.

Human record не создаёт успешный checkpoint или основной cursor. После вопроса Factory
дожидается своего up.sh, health и того же metadata hash. Ошибка среды остаётся отдельной
BOOTSTRAP_ENV_ERROR; вопрос сохранён, BUILD не начинается. Сигнал/EXIT завершают только
принадлежащий процесс подготовки по доверенной identity и сохраняют partial-среду.

Summary и graph читают bootstrapStop при cursor=null. Bootstrap-вердикт не перекрывает
основной scout. Вопрос виден на своём узле с arbitrable=false: арбитр main cursor/goto
его не исполняет. Ошибка среды показывается отдельно от вопроса.

## Ответ и продолжение

`factory TASK bootstrap-answer --profile <profile> --attempt ATTEMPT --node scout
--visit VISIT --stop-hash HASH --answer-file ABS` — короткий CAS. Команда берёт control lock
оркестратора и task lock, проверяет exact identity, текущий stop и непустой ответ до 20000
символов. Повтор того же подтверждённого ответа идемпотентен; иной ответ, stale visit/hash
и живой конкурирующий оркестратор дают отказ. Pin не меняется. Модель и среда не запускаются.

`POST /api/tasks/:id/bootstrap-answer` принимает profile, attempt, phase=bootstrap,
node=scout, visitId, stopHash, answer. Текст передаётся CLI файлом. Сервер проверяет exact
подтверждение и возвращает outcome=recorded. UI отдельно вызывает resume с той же attempt.
Отказ resume сохраняет решение и предлагает повторить только запуск.

Без решения resume удерживает вопрос до runner preflight, снятия STALLED_HUMAN, открытия
lifecycle и подготовки среды. После решения новый visit ссылается на consumed decision,
получает новый run/epoch, typed evidence.bootstrapDecision и служебный блок полного
вопроса/ответа. Текст читается из файла: Unicode-вопрос и ответ предельной длины не
помещаются в один argv/env. Закреплённый prompt не переписывается.

## Установка и проверки

Совместимые readers/API/UI должны работать в обновлённом сервере до живых записей новой
формы. Сервер чата перезапускает человек. Bash-файлы нельзя обновлять под использующим
их оркестратором. После schema 2 rollback требует совместимого reader или явного удержания
таких попыток; историю не мигрируют назад.

Регрессии: bootstrap-results.sh, bootstrap-sandbox.sh, route-dispatch.sh, unit/context.sh,
factory-bootstrap.test.js, bootstrap-results.component.test.js. Они используют настоящий
CLI/dispatcher/status и изолированные опубликованные bundles; модель заменена фикстурой.
Общий validator, capability, CAS и hash-chain сохранены.
