#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/attempt-stage-state.sh"

publisher="$FACTORY_TESTS_HOME/fixtures/routes-publish.mjs"
routes_dir="$TEST_ROOT/routes"

json_field() {
  "$NODE_BIN" -e \
    'const value=JSON.parse(process.argv[1]); let out=value; for (const key of process.argv.slice(2)) out=out[key]; process.stdout.write(out === null ? "null" : String(out));' \
    "$@"
}

event_count() {
  find "$1/stage-results" -maxdepth 1 -type f -name 'event.*.json' | wc -l
}

begin_selected() {
  local task=$1 attempt_id=$2 attempt
  ATTEMPT_STATE_ID_OVERRIDE=$attempt_id
  attempt=$(attempt_state_begin_v2 "$task" demo-profile "$routes_dir") || return
  unset ATTEMPT_STATE_ID_OVERRIDE
  attempt_state_select_route_v2 "$task" "$attempt" debug >/dev/null || return
  printf '%s\n' "$attempt"
}

if [[ -z "${NODE_BIN:-}" || ! -x "$NODE_BIN" ]]; then
  test_fail "host node is available" "NODE_BIN is empty"
  finish_tests
  exit $?
fi

published=$("$NODE_BIN" "$publisher" "$routes_dir" 'Stage ledger' null)
assert_rc 0 "$?" "immutable route fixture is published"
catalog_hash=$(json_field "$published" catalogHash)
route_hash=$(json_field "$published" routeHash)

# Рядом с управляющим состоянием существует старый реестр; он должен остаться побайтно неизменным.
printf 'PROFILE=legacy\nROUTE=feature\nBUILD=done\n' >"$STATE_DIR/t51.pipeline"
legacy_before=$(sha256sum "$STATE_DIR/t51.pipeline" | awk '{print $1}')

attempt=$(begin_selected 51 a_11111111111111111111111111111111)
assert_rc 0 "$?" "selected v2 attempt is prepared"
attempt_dir="$(attempt_state_v2_task_root 51)/attempts/$attempt"

initial=$(attempt_stage_state_init_v2 51 "$attempt" debug)
assert_rc 0 "$?" "execution cursor initializes from the verified route entry"
assert_eq ready "$(json_field "$initial" state)" \
  "initial cursor is ready"
assert_eq instrument "$(json_field "$initial" currentNode)" \
  "initial node comes from the pinned route machine"
assert_eq 0 "$(json_field "$initial" eventSequence)" \
  "initial ledger event has sequence zero"
assert_eq "$catalog_hash" "$(json_field "$initial" catalogHash)" \
  "runtime pins the original catalog"
assert_eq "$route_hash" "$(json_field "$initial" routeHash)" \
  "runtime pins the selected route revision"
assert_eq 1 "$(event_count "$attempt_dir")" \
  "initialization appends exactly one immutable event"

runtime_file="$attempt_dir/stage-results/runtime.json"
first_event=$(find "$attempt_dir/stage-results" -maxdepth 1 -type f -name 'event.*.json')
assert_file_exists "$runtime_file" "checksummed runtime pointer is present"
assert_file_exists "$first_event" "initial hash-chained event is present"
assert_eq 400 "$(stat -c '%a' "$runtime_file")" \
  "runtime pointer is atomically published read-only"
assert_eq 400 "$(stat -c '%a' "$first_event")" \
  "ledger event is immutable after publication"
event_hash=${first_event%.json}
event_hash=${event_hash##*.}
assert_eq "$event_hash" "$(sha256sum "$first_event" | awk '{print $1}')" \
  "event filename is its exact content hash"
assert_eq "$event_hash" "$(json_field "$initial" headEventHash)" \
  "runtime pointer identifies the verified ledger head"

initial_again=$(attempt_stage_state_init_v2 51 "$attempt" debug)
assert_rc 0 "$?" "repeated initialization is idempotent"
assert_eq "$initial" "$initial_again" \
  "idempotent initialization returns the same cursor"
assert_eq 1 "$(event_count "$attempt_dir")" \
  "idempotent initialization does not append another event"

attempt_stage_state_init_v2 51 "$attempt" feature >/dev/null 2>&1
assert_rc 75 "$?" "route mismatch loses the pinned-route CAS"
attempt_stage_state_pause_v2 51 "$attempt" check 'wrong node' >/dev/null 2>&1
assert_rc 75 "$?" "pause requires the exact current node"
assert_eq 1 "$(event_count "$attempt_dir")" \
  "stale pause cannot append to the ledger"

paused=$(attempt_stage_state_pause_v2 51 "$attempt" instrument 'ждём подтверждение причины')
assert_rc 0 "$?" "current node can be paused for a human decision"
assert_eq paused "$(json_field "$paused" state)" \
  "pause changes only the trusted cursor state"
assert_eq instrument "$(json_field "$paused" currentNode)" \
  "pause preserves the current node"
assert_eq 'ждём подтверждение причины' "$(json_field "$paused" pauseReason)" \
  "pause records the bounded human-readable reason"
assert_eq 2 "$(event_count "$attempt_dir")" \
  "pause appends one event"

paused_again=$(attempt_stage_state_pause_v2 51 "$attempt" instrument 'ждём подтверждение причины')
assert_rc 0 "$?" "same pause request is idempotent"
assert_eq "$paused" "$paused_again" \
  "idempotent pause returns the same runtime"
assert_eq 2 "$(event_count "$attempt_dir")" \
  "idempotent pause does not duplicate the event"
attempt_stage_state_pause_v2 51 "$attempt" instrument 'другая причина' >/dev/null 2>&1
assert_rc 75 "$?" "different pause reason loses the state CAS"

after_instrument=$(attempt_stage_state_commit_v2 51 "$attempt" instrument done)
assert_rc 0 "$?" "commit is allowed from the matching paused node"
assert_eq ready "$(json_field "$after_instrument" state)" \
  "next transition resumes a ready cursor"
assert_eq check "$(json_field "$after_instrument" currentNode)" \
  "next node is derived by factory-route"
assert_eq 2 "$(json_field "$after_instrument" lastCommit sequence)" \
  "lastCommit identifies the exact ledger sequence"

after_instrument_again=$(attempt_stage_state_commit_v2 51 "$attempt" instrument done)
assert_rc 0 "$?" "identical completed commit is idempotent"
assert_eq "$after_instrument" "$after_instrument_again" \
  "idempotent commit returns the already committed result"
assert_eq 3 "$(event_count "$attempt_dir")" \
  "idempotent commit does not append another event"
attempt_stage_state_commit_v2 51 "$attempt" instrument failed >/dev/null 2>&1
assert_rc 75 "$?" "different stale outcome cannot overwrite a committed transition"

after_check=$(attempt_stage_state_commit_v2 51 "$attempt" check done)
assert_rc 0 "$?" "command-node transition commits"
assert_eq gate_plan "$(json_field "$after_check" currentNode)" \
  "command outcome advances to the pinned gate"

rewound=$(attempt_stage_state_commit_v2 51 "$attempt" gate_plan rejected)
assert_rc 0 "$?" "gate rejection commits the verified rewind"
assert_eq instrument "$(json_field "$rewound" currentNode)" \
  "rewind target is derived from the route transition"
assert_eq ready "$(json_field "$rewound" state)" \
  "rewind leaves the target ready to run again"
rewind_event=$(find "$attempt_dir/stage-results" -maxdepth 1 -type f \
  -name 'event.00000000000000000004.*.json')
assert_eq instrument "$(json_field "$(cat "$rewind_event")" action rewind)" \
  "rewind ledger event preserves the declared target"
assert_eq instrument,check,gate_plan \
  "$("$NODE_BIN" -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(v.action.reset.join(","));' "$(cat "$rewind_event")")" \
  "rewind ledger event preserves the exact reset interval"
latest_rewind=$(attempt_stage_state_latest_event_v2 51 "$attempt")
assert_rc 0 "$?" "latest-event API verifies the immutable ledger before projection"
assert_eq 4 "$(json_field "$latest_rewind" sequence)" \
  "latest-event API returns the exact committed rewind event"
assert_eq instrument,check,gate_plan \
  "$("$NODE_BIN" -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(v.action.reset.join(","));' "$latest_rewind")" \
  "latest-event API exposes the route-declared reset interval"

after_replay=$(attempt_stage_state_commit_v2 51 "$attempt" instrument done)
assert_rc 0 "$?" "a node can commit again after an explicit rewind"
assert_eq check "$(json_field "$after_replay" currentNode)" \
  "replayed node advances normally"
assert_eq 5 "$(json_field "$after_replay" eventSequence)" \
  "replay is a new append-only event rather than history mutation"

read_back=$(attempt_stage_state_read_v2 51 "$attempt")
assert_rc 0 "$?" "read verifies the complete hash chain and pointer checksum"
assert_eq "$after_replay" "$read_back" \
  "verified read returns the durable runtime exactly"

# Действие остановки выводится из состояния и остаётся идемпотентным.
stop_attempt=$(begin_selected 52 a_22222222222222222222222222222222)
assert_rc 0 "$?" "stop scenario attempt is prepared"
stop_dir="$(attempt_state_v2_task_root 52)/attempts/$stop_attempt"
attempt_stage_state_init_v2 52 "$stop_attempt" debug >/dev/null
stopped=$(attempt_stage_state_commit_v2 52 "$stop_attempt" instrument skipped)
assert_rc 0 "$?" "stop transition commits"
assert_eq stopped "$(json_field "$stopped" state)" \
  "stop transition makes the cursor terminal"
assert_eq human "$(json_field "$stopped" stop)" \
  "stop target comes from the verified route"
assert_eq null "$(json_field "$stopped" currentNode)" \
  "stopped cursor has no executable current node"
stopped_again=$(attempt_stage_state_commit_v2 52 "$stop_attempt" instrument skipped)
assert_rc 0 "$?" "repeated terminal commit is idempotent"
assert_eq "$stopped" "$stopped_again" \
  "terminal idempotence returns the same pointer"
assert_eq 2 "$(event_count "$stop_dir")" \
  "terminal idempotence does not append"

# Для одинаковых конкурентных запросов создаётся одно устойчивое событие и возвращаются два успешных идемпотентных результата.
race_attempt=$(begin_selected 53 a_33333333333333333333333333333333)
assert_rc 0 "$?" "same-outcome race attempt is prepared"
race_dir="$(attempt_state_v2_task_root 53)/attempts/$race_attempt"
attempt_stage_state_init_v2 53 "$race_attempt" debug >/dev/null
(
  attempt_stage_state_commit_v2 53 "$race_attempt" instrument done \
    >"$TEST_ROOT/same-a.out" 2>/dev/null
  printf '%s\n' "$?" >"$TEST_ROOT/same-a.rc"
) &
same_a=$!
(
  attempt_stage_state_commit_v2 53 "$race_attempt" instrument done \
    >"$TEST_ROOT/same-b.out" 2>/dev/null
  printf '%s\n' "$?" >"$TEST_ROOT/same-b.rc"
) &
same_b=$!
wait "$same_a"
wait "$same_b"
same_codes=$(sort -n "$TEST_ROOT/same-a.rc" "$TEST_ROOT/same-b.rc" | paste -sd, -)
assert_eq 0,0 "$same_codes" \
  "concurrent identical commits serialize and both observe success"
assert_eq 2 "$(event_count "$race_dir")" \
  "concurrent identical commits publish one transition event"
assert_eq "$(cat "$TEST_ROOT/same-a.out")" "$(cat "$TEST_ROOT/same-b.out")" \
  "concurrent identical commits return the same durable cursor"

# У конфликтующих конкурентных исходов один победитель и один проигравший из-за устаревшего CAS.
conflict_attempt=$(begin_selected 54 a_44444444444444444444444444444444)
assert_rc 0 "$?" "conflicting race attempt is prepared"
conflict_dir="$(attempt_state_v2_task_root 54)/attempts/$conflict_attempt"
attempt_stage_state_init_v2 54 "$conflict_attempt" debug >/dev/null
(
  attempt_stage_state_commit_v2 54 "$conflict_attempt" instrument done \
    >"$TEST_ROOT/conflict-a.out" 2>/dev/null
  printf '%s\n' "$?" >"$TEST_ROOT/conflict-a.rc"
) &
conflict_a=$!
(
  attempt_stage_state_commit_v2 54 "$conflict_attempt" instrument failed \
    >"$TEST_ROOT/conflict-b.out" 2>/dev/null
  printf '%s\n' "$?" >"$TEST_ROOT/conflict-b.rc"
) &
conflict_b=$!
wait "$conflict_a"
wait "$conflict_b"
conflict_codes=$(sort -n "$TEST_ROOT/conflict-a.rc" "$TEST_ROOT/conflict-b.rc" | paste -sd, -)
assert_eq 0,75 "$conflict_codes" \
  "concurrent conflicting outcomes have one CAS winner"
assert_eq 2 "$(event_count "$conflict_dir")" \
  "losing concurrent outcome cannot append"

# Повреждение приводит к закрытому отказу до следующего перехода.
corrupt_event_attempt=$(begin_selected 55 a_55555555555555555555555555555555)
assert_rc 0 "$?" "event-corruption attempt is prepared"
corrupt_event_dir="$(attempt_state_v2_task_root 55)/attempts/$corrupt_event_attempt"
attempt_stage_state_init_v2 55 "$corrupt_event_attempt" debug >/dev/null
corrupt_event=$(find "$corrupt_event_dir/stage-results" -maxdepth 1 -type f -name 'event.*.json')
chmod 600 "$corrupt_event"
printf '\n' >>"$corrupt_event"
attempt_stage_state_read_v2 55 "$corrupt_event_attempt" >/dev/null 2>&1
assert_rc 78 "$?" "event content or immutability corruption fails closed"
attempt_stage_state_commit_v2 55 "$corrupt_event_attempt" instrument done >/dev/null 2>&1
assert_rc 78 "$?" "corrupt ledger cannot advance"
assert_eq 1 "$(event_count "$corrupt_event_dir")" \
  "corruption failure appends nothing"

corrupt_pointer_attempt=$(begin_selected 56 a_66666666666666666666666666666666)
assert_rc 0 "$?" "pointer-corruption attempt is prepared"
corrupt_pointer_dir="$(attempt_state_v2_task_root 56)/attempts/$corrupt_pointer_attempt"
attempt_stage_state_init_v2 56 "$corrupt_pointer_attempt" debug >/dev/null
pointer="$corrupt_pointer_dir/stage-results/runtime.json"
chmod 600 "$pointer"
"$NODE_BIN" -e \
  'const fs=require("fs"); const p=process.argv[1]; const v=JSON.parse(fs.readFileSync(p)); v.runtime.cursor.currentNode="check"; fs.writeFileSync(p, JSON.stringify(v));' \
  "$pointer"
chmod 400 "$pointer"
attempt_stage_state_read_v2 56 "$corrupt_pointer_attempt" >/dev/null 2>&1
assert_rc 78 "$?" "runtime checksum corruption fails closed"

# CAS активной попытки отклоняет устаревших читателей после явной отмены.
stale_attempt=$(begin_selected 57 a_77777777777777777777777777777777)
assert_rc 0 "$?" "stale-attempt scenario is prepared"
attempt_stage_state_init_v2 57 "$stale_attempt" debug >/dev/null
attempt_state_abandon_v2 57 "$stale_attempt" 'replace previous attempt' >/dev/null
assert_rc 0 "$?" "attempt is explicitly abandoned"
attempt_stage_state_read_v2 57 "$stale_attempt" >/dev/null 2>&1
assert_rc 75 "$?" "stale attempt cannot read an active execution cursor"
attempt_stage_state_commit_v2 57 "$stale_attempt" instrument done >/dev/null 2>&1
assert_rc 75 "$?" "stale attempt cannot commit"

# Указание человека при возврате курсора: журнал — единственный его носитель, и оно
# обязано доехать до промпта того захода, ради которого узел вернули. До этого канала
# свободный человеческий текст был только у ворот, а разбор к обычному узлу приходилось
# протаскивать через черновик хода — то есть мимо журнала.
note_attempt=$(begin_selected 58 a_88888888888888888888888888888888)
assert_rc 0 "$?" "попытка для указания человека подготовлена"
attempt_stage_state_init_v2 58 "$note_attempt" debug >/dev/null
note_read=$(attempt_stage_state_human_note_v2 58 "$note_attempt" instrument)
# rc, а не только текст: «указания нет» — это норма входа в узел, и рантайм читает
# его через `|| return`. Ненулевой код здесь уронил бы диспетчер на ровном месте.
assert_rc 0 "$?" "отсутствие указания не считается ошибкой"
assert_eq "" "$note_read" "обычный вход в узел указания не имеет"

attempt_stage_state_commit_v2 58 "$note_attempt" instrument done >/dev/null
note_text='сначала докажи, что колонка есть, и только потом красный тест'
attempt_stage_state_human_rewind_v2 58 "$note_attempt" instrument \
  instrument,check,gate_plan,retro "$note_text" >/dev/null
assert_rc 0 "$?" "возврат курсора с указанием принят"
assert_eq "$note_text" "$(attempt_stage_state_human_note_v2 58 "$note_attempt" instrument)" \
  "указание читается из журнала дословно"
assert_eq "" "$(attempt_stage_state_human_note_v2 58 "$note_attempt" check)" \
  "указание адресное — соседний узел его не получает"

# Тот же исход после возврата — законный результат, а не «повтор упавшего процесса».
# Идемпотентность по (узел, исход) переживала возврат курсора, и переигранный узел с
# прежним исходом не клал события: курсор не двигался, а диспетчер видел тот же узел
# готовым и гонял по нему агента до потолка шагов. Человек нажимает «перейти сюда»
# как раз на только что закрытом узле, так что путь этот — основной, а не редкий.
note_after=$(attempt_stage_state_commit_v2 58 "$note_attempt" instrument done)
assert_rc 0 "$?" "узел закрыт после отработки указания"
assert_eq check "$(json_field "$note_after" currentNode)" \
  "переигранный узел с прежним исходом двигает курсор дальше"
assert_eq "" "$(attempt_stage_state_human_note_v2 58 "$note_attempt" instrument)" \
  "коммит узла снимает отработанное указание"

# А вот теперь идемпотентность обязана работать снова: возврат отработан, и повтор
# коммита — это уже настоящий переигрыш умершего процесса, второе событие не нужно.
note_events=$(event_count "$(attempt_state_v2_task_root 58)/attempts/$note_attempt")
note_again=$(attempt_stage_state_commit_v2 58 "$note_attempt" instrument done)
assert_rc 0 "$?" "повтор коммита после отработанного указания идемпотентен"
assert_eq "$note_after" "$note_again" "идемпотентный повтор возвращает тот же курсор"
assert_eq "$note_events" \
  "$(event_count "$(attempt_state_v2_task_root 58)/attempts/$note_attempt")" \
  "идемпотентный повтор не кладёт второго события"

# Автономный rewind имеет движковый бюджет поверх immutable route: два одинаковых
# возврата исполняются, третий атомарно останавливает попытку. Это не route-policy:
# старые закреплённые бандлы тоже не должны молотить BUILD↔REVIEW всю ночь.
loop_attempt=$(begin_selected 59 a_99999999999999999999999999999999)
assert_rc 0 "$?" "попытка для лимита возвратов подготовлена"
loop_dir="$(attempt_state_v2_task_root 59)/attempts/$loop_attempt"
attempt_stage_state_init_v2 59 "$loop_attempt" debug >/dev/null

for round in 1 2; do
  attempt_stage_state_commit_v2 59 "$loop_attempt" instrument done 2 >/dev/null
  attempt_stage_state_commit_v2 59 "$loop_attempt" check done 2 >/dev/null
  # Без пятого аргумента — как события, которые успел записать прежний runtime до
  # обновления движка. Новый guard обязан посчитать и их, а не начать с нуля.
  loop_cursor=$(attempt_stage_state_commit_v2 59 "$loop_attempt" gate_plan rejected)
  assert_rc 0 "$?" "автоматический возврат $round укладывается в бюджет"
  assert_eq ready "$(json_field "$loop_cursor" state)" \
    "возврат $round оставляет маршрут исполняемым"
  assert_eq instrument "$(json_field "$loop_cursor" currentNode)" \
    "возврат $round ведёт на объявленную цель"
done

attempt_stage_state_commit_v2 59 "$loop_attempt" instrument done 2 >/dev/null
attempt_stage_state_commit_v2 59 "$loop_attempt" check done 2 >/dev/null
limited=$(attempt_stage_state_commit_v2 59 "$loop_attempt" gate_plan rejected 2)
assert_rc 0 "$?" "третий одинаковый возврат фиксирует безопасную остановку"
assert_eq stopped "$(json_field "$limited" state)" \
  "исчерпанный rewind-бюджет останавливает курсор"
assert_eq rewind-limit "$(json_field "$limited" stop)" \
  "причина остановки отличима от исхода опубликованного маршрута"
assert_eq null "$(json_field "$limited" currentNode)" \
  "после rewind-limit нет автоматически исполняемого узла"
limit_event=$(find "$loop_dir/stage-results" -maxdepth 1 -type f \
  -name 'event.*.json' -print0 | xargs -0 grep -l '"kind": "rewind-limit"')
assert_file_exists "$limit_event" "rewind-limit записан отдельным неизменяемым событием"
assert_eq instrument "$(json_field "$(cat "$limit_event")" action rewind)" \
  "событие сохраняет дугу, которую остановил движок"
assert_contains "$(json_field "$(cat "$limit_event")" reason)" 'уже выполнено 2' \
  "журнал объясняет исчерпанный бюджет"
assert_eq "$limited" "$(attempt_stage_state_read_v2 59 "$loop_attempt")" \
  "ledger с rewind-limit проходит полную проверку цепочки"

# Явное решение человека начинает новый бюджет: оператор видел стоп и осознанно
# вернул курсор, поэтому один следующий rewind не должен немедленно застопориться.
attempt_stage_state_human_rewind_v2 59 "$loop_attempt" instrument \
  instrument,check,gate_plan,retro 'после разбора повторить с новым решением' >/dev/null
attempt_stage_state_commit_v2 59 "$loop_attempt" instrument done 2 >/dev/null
attempt_stage_state_commit_v2 59 "$loop_attempt" check done 2 >/dev/null
after_human=$(attempt_stage_state_commit_v2 59 "$loop_attempt" gate_plan rejected 2)
assert_rc 0 "$?" "человеческий возврат сбрасывает автоматический бюджет"
assert_eq ready "$(json_field "$after_human" state)" \
  "после решения человека первый rewind снова разрешён"
assert_eq instrument "$(json_field "$after_human" currentNode)" \
  "после сброса бюджета сохраняется объявленная цель"

# Typed failed выбирает owner-ветку вместо legacy on.failed. Finding живёт в
# производной проекции immutable ledger и закрывается только успешной повторной
# проверкой того же source-узла.
typed_attempt=$(begin_selected 60 a_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)
assert_rc 0 "$?" "попытка для typed findings подготовлена"
typed_dir="$(attempt_state_v2_task_root 60)/attempts/$typed_attempt"
attempt_stage_state_init_v2 60 "$typed_attempt" debug >/dev/null
attempt_stage_state_commit_v2 60 "$typed_attempt" instrument done >/dev/null
typed_verdict=$(run_state_verdict_encode failed build \
  'check-contract=проверяемый контракт не выполнен')
typed_rewind=$(attempt_stage_state_commit_v2 \
  60 "$typed_attempt" check failed 6 "$typed_verdict" 2)
assert_rc 0 "$?" "typed failed коммитится через доверенный verdict"
assert_eq instrument "$(json_field "$typed_rewind" currentNode)" \
  "owner build выбирает rewind вместо legacy stop"
typed_event=$(find "$typed_dir/stage-results" -maxdepth 1 -type f \
  -name 'event.00000000000000000002.*.json')
assert_eq build "$(json_field "$(cat "$typed_event")" verdict owner)" \
  "ledger сохраняет владельца замечания"
assert_eq check-contract \
  "$(json_field "$(cat "$typed_event")" verdict findings 0 id)" \
  "ledger сохраняет стабильный finding id"

findings_open=$(attempt_stage_state_findings_v2 60 "$typed_attempt")
assert_rc 0 "$?" "проекция findings проверяет hash-chain перед чтением"
assert_eq 1 "$(json_field "$findings_open" open length)" \
  "неисправленное замечание остаётся открытым"
assert_eq check-contract "$(json_field "$findings_open" open 0 id)" \
  "open-проекция возвращает точный finding"

attempt_stage_state_commit_v2 60 "$typed_attempt" instrument done >/dev/null
attempt_stage_state_commit_v2 60 "$typed_attempt" check done >/dev/null
findings_closed=$(attempt_stage_state_findings_v2 60 "$typed_attempt")
assert_eq 0 "$(json_field "$findings_closed" open length)" \
  "успешная повторная проверка закрывает прежнее замечание"
assert_eq 1 "$(json_field "$findings_closed" closed length)" \
  "закрытый finding остаётся в проверяемой истории"
assert_eq closed "$(json_field "$findings_closed" closed 0 status)" \
  "проекция явно маркирует закрытый finding"

# Typed-цикл останавливается по наблюдаемому отсутствию прогресса раньше общего
# hard ceiling: третий одинаковый fingerprint уже доказал, что BUILD↔CHECK застрял.
no_progress_attempt=$(begin_selected 61 a_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)
assert_rc 0 "$?" "попытка для no-progress guard подготовлена"
no_progress_dir="$(attempt_state_v2_task_root 61)/attempts/$no_progress_attempt"
attempt_stage_state_init_v2 61 "$no_progress_attempt" debug >/dev/null
for round in 1 2; do
  attempt_stage_state_commit_v2 61 "$no_progress_attempt" instrument done >/dev/null
  repeated=$(attempt_stage_state_commit_v2 \
    61 "$no_progress_attempt" check failed 6 "$typed_verdict" 2)
  assert_eq ready "$(json_field "$repeated" state)" \
    "одинаковый typed rewind $round ещё допускает исправление"
done
attempt_stage_state_commit_v2 61 "$no_progress_attempt" instrument done >/dev/null
no_progress=$(attempt_stage_state_commit_v2 \
  61 "$no_progress_attempt" check failed 6 "$typed_verdict" 2)
assert_rc 0 "$?" "третий одинаковый typed rewind фиксируется атомарно"
assert_eq stopped "$(json_field "$no_progress" state)" \
  "повторяющиеся findings останавливают автоматический цикл"
assert_eq no-progress "$(json_field "$no_progress" stop)" \
  "причина остановки — отсутствие прогресса, не hard ceiling"
no_progress_event=$(find "$no_progress_dir/stage-results" -maxdepth 1 -type f \
  -name 'event.*.json' -print0 | xargs -0 grep -l '"kind": "no-progress"')
assert_file_exists "$no_progress_event" \
  "no-progress записан отдельным неизменяемым событием"
assert_contains "$(json_field "$(cat "$no_progress_event")" reason)" \
  'тот же набор открытых замечаний' \
  "журнал объясняет наблюдаемое отсутствие прогресса"

# Rejected на воротах — такое же осознанное вмешательство человека, как goto.
# Новая обратная связь не должна наследовать fingerprint старого цикла.
gate_reset_attempt=$(begin_selected 62 a_cccccccccccccccccccccccccccccccc)
assert_rc 0 "$?" "попытка для сброса истории воротами подготовлена"
attempt_stage_state_init_v2 62 "$gate_reset_attempt" debug >/dev/null
attempt_stage_state_commit_v2 62 "$gate_reset_attempt" instrument done >/dev/null
attempt_stage_state_commit_v2 \
  62 "$gate_reset_attempt" check failed 6 "$typed_verdict" 1 >/dev/null
attempt_stage_state_commit_v2 62 "$gate_reset_attempt" instrument done >/dev/null
attempt_stage_state_commit_v2 62 "$gate_reset_attempt" check done >/dev/null
attempt_stage_state_commit_v2 62 "$gate_reset_attempt" gate_plan rejected >/dev/null
attempt_stage_state_commit_v2 62 "$gate_reset_attempt" instrument done >/dev/null
after_gate_feedback=$(attempt_stage_state_commit_v2 \
  62 "$gate_reset_attempt" check failed 6 "$typed_verdict" 1)
assert_rc 0 "$?" "typed failed после rejected ворот коммитится"
assert_eq ready "$(json_field "$after_gate_feedback" state)" \
  "rejected ворот начинает новую автономную серию findings"
assert_eq instrument "$(json_field "$after_gate_feedback" currentNode)" \
  "после человеческой обратной связи исправление снова разрешено"

# Набор замечаний меняется от захода к заходу, но одно и то же переживает каждый
# ремонт. Полное совпадение отпечатка такое не ловит: смена одного finding из двух
# читается прогрессом, и цикл ходит вокруг неснятой причины, пока сопутствующие
# замечания тасуются. Останавливает именно ПЕРЕСЕЧЕНИЕ наборов.
core_attempt=$(begin_selected 63 a_dddddddddddddddddddddddddddddddd)
assert_rc 0 "$?" "попытка для устойчивого ядра подготовлена"
core_dir="$(attempt_state_v2_task_root 63)/attempts/$core_attempt"
attempt_stage_state_init_v2 63 "$core_attempt" debug >/dev/null
core_first=$(run_state_verdict_encode failed build \
  'shared-cause=причина не отделена от места проявления' \
  'first-side=побочное замечание первого захода')
core_second=$(run_state_verdict_encode failed build \
  'shared-cause=причина не отделена от места проявления' \
  'second-side=побочное замечание второго захода')
core_third=$(run_state_verdict_encode failed build \
  'shared-cause=причина не отделена от места проявления' \
  'third-side=побочное замечание третьего захода')
for verdict in "$core_first" "$core_second"; do
  attempt_stage_state_commit_v2 63 "$core_attempt" instrument done >/dev/null
  moving=$(attempt_stage_state_commit_v2 \
    63 "$core_attempt" check failed 6 "$verdict" 2)
  assert_eq ready "$(json_field "$moving" state)" \
    "смена сопутствующих замечаний ещё допускает исправление"
done
attempt_stage_state_commit_v2 63 "$core_attempt" instrument done >/dev/null
core_stop=$(attempt_stage_state_commit_v2 \
  63 "$core_attempt" check failed 6 "$core_third" 2)
assert_rc 0 "$?" "третий заход с тем же ядром фиксируется атомарно"
assert_eq stopped "$(json_field "$core_stop" state)" \
  "неснимаемое замечание останавливает автоматический цикл"
assert_eq no-progress "$(json_field "$core_stop" stop)" \
  "устойчивое ядро — отсутствие прогресса, а не hard ceiling"
core_event=$(find "$core_dir/stage-results" -maxdepth 1 -type f \
  -name 'event.*.json' -print0 | xargs -0 grep -l '"kind": "no-progress"')
assert_file_exists "$core_event" \
  "устойчивое ядро записано отдельным неизменяемым событием"
assert_contains "$(json_field "$(cat "$core_event")" reason)" 'shared-cause' \
  "журнал называет замечание, которое ремонт не снимает"

# Обратная сторона того же сторожа: замечания закрываются по одному, набор строго
# сужается — пересечение непусто, но это прогресс, и обрывать цикл нельзя.
shrink_attempt=$(begin_selected 64 a_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee)
assert_rc 0 "$?" "попытка для сужающегося набора подготовлена"
attempt_stage_state_init_v2 64 "$shrink_attempt" debug >/dev/null
shrink_first=$(run_state_verdict_encode failed build \
  'kept-finding=замечание, которое чинят последним' \
  'closed-second=замечание, закрытое вторым' \
  'closed-first=замечание, закрытое первым')
shrink_second=$(run_state_verdict_encode failed build \
  'kept-finding=замечание, которое чинят последним' \
  'closed-second=замечание, закрытое вторым')
shrink_third=$(run_state_verdict_encode failed build \
  'kept-finding=замечание, которое чинят последним')
for verdict in "$shrink_first" "$shrink_second" "$shrink_third"; do
  attempt_stage_state_commit_v2 64 "$shrink_attempt" instrument done >/dev/null
  shrinking=$(attempt_stage_state_commit_v2 \
    64 "$shrink_attempt" check failed 6 "$verdict" 2)
  assert_eq ready "$(json_field "$shrinking" state)" \
    "последовательное закрытие замечаний остаётся прогрессом"
done

# Наборы вообще не пересекаются: каждый заход находит новое. Ядра нет, значит и
# повода останавливать цикл раньше hard ceiling тоже нет.
fresh_attempt=$(begin_selected 65 a_ffffffffffffffffffffffffffffffff)
assert_rc 0 "$?" "попытка для непересекающихся наборов подготовлена"
attempt_stage_state_init_v2 65 "$fresh_attempt" debug >/dev/null
for finding in first second third; do
  fresh_verdict=$(run_state_verdict_encode failed build \
    "only-$finding=замечание, найденное только в этом заходе")
  attempt_stage_state_commit_v2 65 "$fresh_attempt" instrument done >/dev/null
  fresh=$(attempt_stage_state_commit_v2 \
    65 "$fresh_attempt" check failed 6 "$fresh_verdict" 2)
  assert_eq ready "$(json_field "$fresh" state)" \
    "полностью новый набор замечаний прогрессом и остаётся"
done

legacy_after=$(sha256sum "$STATE_DIR/t51.pipeline" | awk '{print $1}')
assert_eq "$legacy_before" "$legacy_after" \
  "all stage-ledger operations leave legacy STATE_DIR byte-for-byte untouched"

finish_tests
