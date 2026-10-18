# «fail-closed (код 75)» после прогона e2e = сторож state-only поймал runtime-артефакт Playwright

Инцидент 11.09.2026, <TASK> (маршрут feature, профиль <PROFILE>): критик тестов отработал
штатно (`runner_finished: succeeded`, вердикт `failed` с owner tests записан через
`stage-result.sh`), но следом `node_execution_finished status=interrupted reasonCode=unavailable`,
`orchestrator_session_finished status=failed`, в `stages.log` одна строка «dispatcher остановлен
fail-closed (код 75)», в карточке «причина не нашлась в журнале». Вердикт критика выброшен,
`STALLED_HUMAN=1`, `resume` упирался бы в то же место.

Причина: узел `state-only`, а промпт требует гонять e2e через `profiles/<PROFILE>/e2e.sh`.
Playwright `tests/e2e/auth.setup.ts` пишет storage state в `e2e/.auth/user.json`
ОТНОСИТЕЛЬНО cwd (корень фронта), а `.gitignore` проекта закрывает только `tests/e2e/.auth/`
(расхождение внесла задача <TASK>, в ветке 8668 путь уже сведён к `tests/e2e/`). Каждый логин
даёт новый токен → untracked-файл меняется → сторож дерева (`_route_v2_guard_snapshot`,
before/after) честно видит расхождение → 75. Тот же файл до этого ронял `verify` у <TASK>
(четыре раза; человек искал причину в браузере Playwright) и <TASK> (плюс `e2e/screenshots/*.png`).

Где искать диагноз по старым журналам: `~/.factory/control/guards-v2/t<TASK>/<attempt>/<node>/
sequence-N.after.diff` — строки `±UNTRACKED <base64 root> <base64 rel>`; расшифровать `base64 -d`.

Лечение 11.09.2026 (три слоя):
- движок называет причину в `stages.log`: `<RUN_KEY>: сторож state-only: узел <node> изменил
  рабочее дерево — UNTRACKED <каталог> (<файлов>)` + подсказка; GrigDesk разбирает её в карточку
  (`stall.ts`, вид `guard`), а голое «fail-closed (код N)» теперь тоже распознаётся слабым правилом;
- профиль объявляет runtime-пути проверок хуком `profile_route_volatile_paths` (`имя-репо<TAB>путь`):
  untracked-файлы под ними в снимок сторожа не попадают; tracked, index и sensitive под теми же
  путями сторожатся как прежде (PROFILE-CONTRACT § Доступ агента). У <PROFILE> объявлены
  `frontend e2e/.auth`, `e2e/screenshots`, `e2e/traces`; список пишется рядом со снимком
  (`sequence-N.volatile.list`);
- правильный `.gitignore`/пути в самом проекте делают объявление ненужным — но базовые ревизии
  старых задач его не содержат, поэтому объявление остаётся.

Не покрыто: транзакционные узлы (`instrument → proof`) сравнивают снимки своим CAS
(`instrumentation_tx_checkpoint`), объявление runtime-путей туда не проведено — тот же
артефакт даст `out_of_scope_change`, но уже С причиной в журнале (`_route_v2_log_transaction_stall`).
