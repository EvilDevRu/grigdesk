#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/attempt-stage-state.sh"
source "$FACTORY_HOME/lib/route-runtime.sh"

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

# Свободный текст ворот нельзя молча адресовать автоматическому command: он не читает
# промпт и первым же коммитом погасил бы указание. Stop при этом законен — текст
# остаётся аудитом решения, а не обещанием следующему агенту.
feedback_description="$TEST_ROOT/feedback-description.json"
cat >"$feedback_description" <<'JSON'
{
  "machine": {
    "nodes": [
      {"id":"verify","executor":"command"},
      {"id":"author","executor":"agent"},
      {
        "id":"gate_command","executor":"gate",
        "on":{"rejected":{"rewind":"verify","reset":["verify","gate_command"]}}
      },
      {
        "id":"gate_next_command","executor":"gate",
        "on":{"rejected":{"next":"verify"}}
      },
      {
        "id":"gate_next_agent","executor":"gate",
        "on":{"rejected":{"next":"author"}}
      },
      {
        "id":"gate_stop","executor":"gate",
        "on":{"rejected":{"stop":"human"}}
      }
    ]
  }
}
JSON
feedback_guard=$(_route_v2_gate_feedback_guard \
  "$feedback_description" gate_command 'исправь проверку' 2>&1)
assert_rc 78 "$?" "feedback-bearing gate refuses a command rewind target"
assert_contains "$feedback_guard" 'executor=command' \
  "command target refusal explains why feedback cannot be delivered"
_route_v2_gate_feedback_guard \
  "$feedback_description" gate_next_command 'перепроверь дальше' >/dev/null 2>&1
assert_rc 78 "$?" "feedback-bearing rejected next also refuses a command target"
_route_v2_gate_feedback_guard \
  "$feedback_description" gate_next_agent 'исправь по пути дальше'
assert_rc 0 "$?" "feedback-bearing rejected next accepts an agent target"
_route_v2_gate_feedback_guard "$feedback_description" gate_stop 'остановить работу'
assert_rc 0 "$?" "rejected stop may retain feedback as immutable audit"

next_feedback_dir="$TEST_ROOT/next-feedback-events"
mkdir -p "$next_feedback_dir"
next_feedback='переделай следующий агентский узел'
next_feedback_event="$next_feedback_dir/event.00000000000000000001.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json"
cat >"$next_feedback_event" <<JSON
{"kind":"commit","node":"gate_next_agent","outcome":"rejected","reason":"$next_feedback","action":{"next":"author"}}
JSON
chmod 400 "$next_feedback_event"
assert_eq "$next_feedback" \
  "$(_attempt_stage_state_json human-note "$next_feedback_dir" author)" \
  "rejected next addresses feedback to its agent target"
assert_eq "" "$(_attempt_stage_state_json human-note "$next_feedback_dir" verify)" \
  "rejected next feedback remains target-specific"
next_feedback_commit="$next_feedback_dir/event.00000000000000000002.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json"
cat >"$next_feedback_commit" <<'JSON'
{"kind":"commit","node":"author","outcome":"done","reason":null,"action":{"next":"retro"}}
JSON
chmod 400 "$next_feedback_commit"
assert_eq "" "$(_attempt_stage_state_json human-note "$next_feedback_dir" author)" \
  "agent commit clears feedback delivered through rejected next"

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

gate_feedback='сначала уточни план по замечанию приёмки'
rewound=$(attempt_stage_state_commit_v2 \
  51 "$attempt" gate_plan rejected 0 '' 0 0 0 "$gate_feedback")
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
assert_eq "$gate_feedback" "$(json_field "$(cat "$rewind_event")" reason)" \
  "rejected gate feedback is durable in the immutable event"
assert_eq "$gate_feedback" "$(attempt_stage_state_human_note_v2 51 "$attempt" instrument)" \
  "rejected gate feedback is addressed to the declared rewind target"
rewind_events=$(event_count "$attempt_dir")
rewound_again=$(attempt_stage_state_commit_v2 \
  51 "$attempt" gate_plan rejected 0 '' 0 0 0 "$gate_feedback")
assert_rc 0 "$?" "exact rejected feedback retry is idempotent"
assert_eq "$rewound" "$rewound_again" \
  "exact rejected feedback retry returns the committed cursor"
assert_eq "$rewind_events" "$(event_count "$attempt_dir")" \
  "exact rejected feedback retry appends no event"
attempt_stage_state_commit_v2 \
  51 "$attempt" gate_plan rejected 0 '' 0 0 0 'уже другое замечание' \
  >/dev/null 2>&1
assert_rc 75 "$?" "changed feedback cannot masquerade as an idempotent retry"
assert_eq "$gate_feedback" "$(attempt_stage_state_human_note_v2 51 "$attempt" instrument)" \
  "conflicting retry preserves the originally committed feedback"
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
assert_eq "" "$(attempt_stage_state_human_note_v2 51 "$attempt" instrument)" \
  "target commit clears rejected gate feedback after it was handled"

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

# Возврат на узел, где курсор УЖЕ стоит, — основной путь кокпита: человек жмёт
# «перейти сюда» на текущем этапе именно затем, чтобы приложить к нему указание.
# Раньше такой заход считался пустым (курсор двигать некуда), событие не ложилось, а
# `factory goto` печатал «курсор возвращён» и отвечал успехом: указание пропадало
# молча. На t7802 так потерялось решение владельца, и следующий заход диагностики
# ушёл без него.
note_same=$(event_count "$(attempt_state_v2_task_root 58)/attempts/$note_attempt")
attempt_stage_state_human_rewind_v2 58 "$note_attempt" instrument \
  instrument,check,gate_plan,retro "$note_text" >/dev/null
assert_rc 0 "$?" "повтор возврата с тем же указанием принят"
assert_eq "$note_same" \
  "$(event_count "$(attempt_state_v2_task_root 58)/attempts/$note_attempt")" \
  "дословный повтор указания не кладёт второго события"

note_fresh='инвариант «одна живая группа» — закон, зелёный тест переписывается'
attempt_stage_state_human_rewind_v2 58 "$note_attempt" instrument \
  instrument,check,gate_plan,retro "$note_fresh" >/dev/null
assert_rc 0 "$?" "новое указание на текущем узле принято"
assert_eq "$note_fresh" "$(attempt_stage_state_human_note_v2 58 "$note_attempt" instrument)" \
  "последнее слово человека доезжает до узла, на котором курсор уже стоял"
assert_eq $((note_same + 1)) \
  "$(event_count "$(attempt_state_v2_task_root 58)/attempts/$note_attempt")" \
  "новое указание ложится событием, а не теряется"

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

# Коммит восстановления узел НЕ исполнял: подъём после обрыва снимает инструментацию,
# на которой стоял диагностический узел, и закрывает его `failed`, чтобы маршрут
# переразметил заново. Указание человека такой коммит снимать не имеет права — иначе
# получается петля t7802: решение владельца приложено, «продолжить» закрывает узел за
# отсутствующую разметку, и обратно узел входит уже без решения.
note_recovery='смотри на обе ветки записи, не только на restore'
attempt_stage_state_human_rewind_v2 58 "$note_attempt" instrument \
  instrument,check,gate_plan,retro "$note_recovery" >/dev/null
assert_rc 0 "$?" "указание к узлу перед восстановлением принято"
note_recovered=$(attempt_stage_state_commit_v2 58 "$note_attempt" instrument done 0 '' 0 1)
assert_rc 0 "$?" "коммит восстановления принят"
assert_eq check "$(json_field "$note_recovered" currentNode)" \
  "восстановление двигает курсор так же, как обычный коммит"
assert_eq "$note_recovery" "$(attempt_stage_state_human_note_v2 58 "$note_attempt" instrument)" \
  "коммит восстановления не снимает указание: узел его не отрабатывал"
# Маршрут после восстановления возвращает курсор на тот же узел (в debug — через
# повторную инструментацию), и вот ЭТОТ заход указание уже отрабатывает.
attempt_stage_state_human_rewind_v2 58 "$note_attempt" instrument \
  instrument,check,gate_plan,retro "$note_recovery" >/dev/null
assert_rc 0 "$?" "курсор вернулся на узел после восстановления"
assert_eq "$note_recovery" "$(attempt_stage_state_human_note_v2 58 "$note_attempt" instrument)" \
  "указание дожило до настоящего захода"
attempt_stage_state_commit_v2 58 "$note_attempt" instrument done >/dev/null
assert_rc 0 "$?" "настоящий заход после восстановления закрывает узел"
assert_eq "" "$(attempt_stage_state_human_note_v2 58 "$note_attempt" instrument)" \
  "отработанное указание снимает именно исполнение узла"

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
# hard ceiling: после одного ремонта второй одинаковый fingerprint уже требует человека.
no_progress_attempt=$(begin_selected 61 a_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)
assert_rc 0 "$?" "попытка для no-progress guard подготовлена"
no_progress_dir="$(attempt_state_v2_task_root 61)/attempts/$no_progress_attempt"
attempt_stage_state_init_v2 61 "$no_progress_attempt" debug >/dev/null
attempt_stage_state_commit_v2 61 "$no_progress_attempt" instrument done >/dev/null
first_repair=$(attempt_stage_state_commit_v2 \
  61 "$no_progress_attempt" check failed 6 "$typed_verdict" 2)
assert_eq ready "$(json_field "$first_repair" state)" \
  "первый typed verdict допускает один автоматический ремонт"
attempt_stage_state_commit_v2 61 "$no_progress_attempt" instrument done >/dev/null
reworded_verdict=$(run_state_verdict_encode failed build \
  'check-contract=то же замечание с уточнённой формулировкой после ремонта')
no_progress=$(attempt_stage_state_commit_v2 \
  61 "$no_progress_attempt" check failed 6 "$reworded_verdict" 2)
assert_rc 0 "$?" "повтор id после одного ремонта фиксируется атомарно"
assert_eq stopped "$(json_field "$no_progress" state)" \
  "тот же набор findings не запускает второй автоматический ремонт"
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
after_feedback_verdict=$(run_state_verdict_encode failed build \
  'after-human-feedback=новое замечание после решения человека')
after_gate_feedback=$(attempt_stage_state_commit_v2 \
  62 "$gate_reset_attempt" check failed 6 "$after_feedback_verdict" 1)
assert_rc 0 "$?" "typed failed после rejected ворот коммитится"
assert_eq ready "$(json_field "$after_gate_feedback" state)" \
  "rejected ворот разрешает новый замкнутый набор findings"
assert_eq instrument "$(json_field "$after_gate_feedback" currentNode)" \
  "после человеческой обратной связи исправление снова разрешено"

# Набор строго сужается, но одно и то же замечание переживает каждый ремонт.
# Расширения scope тут нет; третий проход останавливает прежний guard устойчивого ядра.
core_attempt=$(begin_selected 63 a_dddddddddddddddddddddddddddddddd)
assert_rc 0 "$?" "попытка для устойчивого ядра подготовлена"
core_dir="$(attempt_state_v2_task_root 63)/attempts/$core_attempt"
attempt_stage_state_init_v2 63 "$core_attempt" debug >/dev/null
core_first=$(run_state_verdict_encode failed build \
  'shared-cause=причина не отделена от места проявления' \
  'closed-second=побочное замечание, закрытое вторым' \
  'closed-first=побочное замечание, закрытое первым')
core_second=$(run_state_verdict_encode failed build \
  'shared-cause=причина не отделена от места проявления' \
  'closed-second=побочное замечание, закрытое вторым')
core_third=$(run_state_verdict_encode failed build \
  'shared-cause=причина не отделена от места проявления')
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

# Форма 8162: три круга с общим ядром и строго сужающимся хвостом. Сужение
# хвоста — не прогресс, пока само ядро переживает каждый ремонт: на 8162 правило
# «строгое сужение = прогресс» разоружило сторож, и дуга review→build крутилась
# 3.5 часа, пока конвейер не остановил человек.
shrink_attempt=$(begin_selected 64 a_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee)
assert_rc 0 "$?" "попытка для сужающегося набора подготовлена"
shrink_dir="$(attempt_state_v2_task_root 64)/attempts/$shrink_attempt"
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
for verdict in "$shrink_first" "$shrink_second"; do
  attempt_stage_state_commit_v2 64 "$shrink_attempt" instrument done >/dev/null
  shrinking=$(attempt_stage_state_commit_v2 \
    64 "$shrink_attempt" check failed 6 "$verdict" 2)
  assert_eq ready "$(json_field "$shrinking" state)" \
    "закрытие хвоста в пределах окна ещё допускает исправление"
done
attempt_stage_state_commit_v2 64 "$shrink_attempt" instrument done >/dev/null
shrink_stop=$(attempt_stage_state_commit_v2 \
  64 "$shrink_attempt" check failed 6 "$shrink_third" 2)
assert_rc 0 "$?" "третий заход с живым ядром фиксируется атомарно"
assert_eq stopped "$(json_field "$shrink_stop" state)" \
  "сужение хвоста при живом ядре останавливает цикл"
assert_eq no-progress "$(json_field "$shrink_stop" stop)" \
  "неснятое ядро — отсутствие прогресса, а не hard ceiling"
shrink_event=$(find "$shrink_dir/stage-results" -maxdepth 1 -type f \
  -name 'event.*.json' -print0 | xargs -0 grep -l '"kind": "no-progress"')
assert_file_exists "$shrink_event" \
  "остановка по ядру записана отдельным неизменяемым событием"
assert_contains "$(json_field "$(cat "$shrink_event")" reason)" 'kept-finding' \
  "журнал называет замечание, пережившее все ремонты серии"

# Первый typed verdict замыкает блокирующий scope дуги. Полностью новый набор на
# повторе раньше считался прогрессом и именно поэтому критик мог растить задачу до
# hard ceiling; теперь verdict остаётся в ledger, но автоматический rewind прекращается.
fresh_attempt=$(begin_selected 65 a_ffffffffffffffffffffffffffffffff)
assert_rc 0 "$?" "попытка для непересекающихся наборов подготовлена"
fresh_dir="$(attempt_state_v2_task_root 65)/attempts/$fresh_attempt"
attempt_stage_state_init_v2 65 "$fresh_attempt" debug >/dev/null
fresh_first=$(run_state_verdict_encode failed build \
  'only-first=замечание первого прохода')
fresh_second=$(run_state_verdict_encode failed build \
  'only-second=новое замечание повторного прохода')
attempt_stage_state_commit_v2 65 "$fresh_attempt" instrument done >/dev/null
fresh=$(attempt_stage_state_commit_v2 \
  65 "$fresh_attempt" check failed 6 "$fresh_first" 2)
assert_eq ready "$(json_field "$fresh" state)" \
  "первый набор замечаний разрешает исправление"
attempt_stage_state_commit_v2 65 "$fresh_attempt" instrument done >/dev/null
fresh_stop=$(attempt_stage_state_commit_v2 \
  65 "$fresh_attempt" check failed 6 "$fresh_second" 2)
assert_eq stopped "$(json_field "$fresh_stop" state)" \
  "новый набор не запускает второй автоматический ремонт"
assert_eq no-progress "$(json_field "$fresh_stop" stop)" \
  "расширение scope останавливается у человека"
fresh_event=$(find "$fresh_dir/stage-results" -maxdepth 1 -type f \
  -name 'event.*.json' -print0 | xargs -0 grep -l '"kind": "no-progress"')
assert_contains "$(json_field "$(cat "$fresh_event")" reason)" \
  'замкнутый набор замечаний расширен новыми id: only-second' \
  "журнал называет новый id, разомкнувший scope"

# Суммарный бюджет возвратов в target тестируется отдельно, с выключенным
# no-progress у примитива: в живом typed runtime свежие id раньше остановит scope guard.
# Бюджет решением человека НЕ обнуляется — иначе «вернул курсор» выдавало бы новую порцию.
budget_attempt=$(begin_selected 67 a_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6)
assert_rc 0 "$?" "попытка для суммарного бюджета подготовлена"
budget_dir="$(attempt_state_v2_task_root 67)/attempts/$budget_attempt"
attempt_stage_state_init_v2 67 "$budget_attempt" debug >/dev/null
for round in 1 2 3; do
  budget_verdict=$(run_state_verdict_encode failed build \
    "budget-finding-$round=свежее замечание круга $round")
  attempt_stage_state_commit_v2 67 "$budget_attempt" instrument done >/dev/null
  budget_run=$(attempt_stage_state_commit_v2 \
    67 "$budget_attempt" check failed 6 "$budget_verdict" 0 0 3)
  assert_eq ready "$(json_field "$budget_run" state)" \
    "возврат $round укладывается в суммарный бюджет"
done
budget_verdict=$(run_state_verdict_encode failed build \
  'budget-finding-4=свежее замечание четвёртого круга')
attempt_stage_state_commit_v2 67 "$budget_attempt" instrument done >/dev/null
budget_stop=$(attempt_stage_state_commit_v2 \
  67 "$budget_attempt" check failed 6 "$budget_verdict" 0 0 3)
assert_rc 0 "$?" "четвёртый возврат при бюджете трёх фиксируется атомарно"
assert_eq stopped "$(json_field "$budget_stop" state)" \
  "исчерпанный суммарный бюджет останавливает курсор"
assert_eq rewind-limit "$(json_field "$budget_stop" stop)" \
  "остановка по бюджету остаётся human-resumable rewind-limit"
budget_event=$(find "$budget_dir/stage-results" -maxdepth 1 -type f \
  -name 'event.*.json' -print0 | xargs -0 grep -l '"kind": "rewind-limit"')
assert_contains "$(json_field "$(cat "$budget_event")" reason)" \
  'суммарный бюджет автоматических возвратов' \
  "журнал отличает бюджет от лимита дуги"
assert_contains "$(json_field "$(cat "$budget_event")" reason)" 'уже выполнено 3' \
  "журнал называет исчерпанный размер бюджета"

# Решение человека не выдаёт новый бюджет: после goto сам же счётчик держит
# серию остановленной, пока человек не решит судьбу попытки целиком.
attempt_stage_state_human_rewind_v2 67 "$budget_attempt" instrument \
  instrument,check,gate_plan,retro 'проверить с человеческим указанием' >/dev/null
attempt_stage_state_commit_v2 67 "$budget_attempt" instrument done >/dev/null
budget_after_human=$(attempt_stage_state_commit_v2 \
  67 "$budget_attempt" check failed 6 "$budget_verdict" 2 0 3)
assert_eq stopped "$(json_field "$budget_after_human" state)" \
  "человеческий возврат не обнуляет суммарный бюджет"
assert_eq rewind-limit "$(json_field "$budget_after_human" stop)" \
  "причина остановки после goto — тот же исчерпанный бюджет"

# --- Учёт отработанного времени по узлам (work-time) ---
# Часы под контролем теста: интервал [предыдущее событие -> коммит] относится
# к узлу коммита; pause получает ноль, поэтому ожидание ворот не размазывается
# по рабочим узлам.
wt_attempt=$(begin_selected 66 a_0123456789abcdef0123456789abcdef)
assert_rc 0 "$?" "work-time attempt is prepared"
ATTEMPT_STAGE_STATE_TIME_OVERRIDE='2026-01-01T00:00:00Z' \
  attempt_stage_state_init_v2 66 "$wt_attempt" debug >/dev/null
assert_rc 0 "$?" "work-time init uses the controlled clock"
ATTEMPT_STAGE_STATE_TIME_OVERRIDE='2026-01-01T00:02:00Z' \
  attempt_stage_state_commit_v2 66 "$wt_attempt" instrument done >/dev/null
assert_rc 0 "$?" "work-time agent node commits"
ATTEMPT_STAGE_STATE_TIME_OVERRIDE='2026-01-01T00:02:05Z' \
  attempt_stage_state_commit_v2 66 "$wt_attempt" check done >/dev/null
assert_rc 0 "$?" "work-time command node commits"
ATTEMPT_STAGE_STATE_TIME_OVERRIDE='2026-01-01T00:02:05Z' \
  attempt_stage_state_pause_v2 66 "$wt_attempt" gate_plan 'human gate: gate_plan' >/dev/null
assert_rc 0 "$?" "work-time gate entry pauses the cursor"
ATTEMPT_STAGE_STATE_TIME_OVERRIDE='2026-01-01T01:02:05Z' \
  attempt_stage_state_commit_v2 66 "$wt_attempt" gate_plan approved >/dev/null
assert_rc 0 "$?" "work-time gate decision commits"
ATTEMPT_STAGE_STATE_TIME_OVERRIDE='2026-01-01T01:03:05Z' \
  attempt_stage_state_commit_v2 66 "$wt_attempt" retro done >/dev/null
assert_rc 0 "$?" "work-time tail node commits"

wt=$(attempt_stage_state_work_time_v2 66 "$wt_attempt")
assert_rc 0 "$?" "work-time projection reads the verified ledger"
assert_eq 120 "$(json_field "$wt" nodes instrument)" \
  "agent node gets the interval since the previous event"
assert_eq 5 "$(json_field "$wt" nodes check)" \
  "command node gets its dispatch interval"
assert_eq 3600 "$(json_field "$wt" nodes gate_plan)" \
  "gate node gets the human decision wait"
assert_eq 60 "$(json_field "$wt" nodes retro)" \
  "tail node gets the post-gate interval"
wt_last=$(date -u -d '2026-01-01 01:03:05' +%s)
assert_eq "$wt_last" "$(json_field "$wt" lastEventAt)" \
  "lastEventAt is the epoch of the newest ledger event"

# Классификация ворот — по executor из pinned describe-route, а не по имени:
# работа узлов без ворот отдельно, ожидание ворот отдельно.
"$FACTORY_HOME/bin/factory-route" \
  --routes-dir "$routes_dir" --profile demo-profile describe-route \
  --catalog-hash "$catalog_hash" --route debug >"$TEST_ROOT/work/wt-describe.json"
assert_rc 0 "$?" "describe-route for the pinned debug machine"
printf '%s\n' "$wt" >"$TEST_ROOT/work/wt-ledger.json"
wt_joined=$(_route_v2_json work-time \
  "$TEST_ROOT/work/wt-describe.json" "$TEST_ROOT/work/wt-ledger.json")
assert_rc 0 "$?" "work-time join classifies nodes by bundle executor"
assert_eq "$(printf '185\t3600\t%s' "$wt_last")" "$wt_joined" \
  "work excludes gate wait; gate wait and last event stay separate"

printf '%s\n' '{"schema":1,"nodes":{"ghost":7},"lastEventAt":1}' \
  >"$TEST_ROOT/work/wt-ledger-bad.json"
_route_v2_json work-time \
  "$TEST_ROOT/work/wt-describe.json" "$TEST_ROOT/work/wt-ledger-bad.json" >/dev/null 2>&1
assert_rc 78 "$?" "ledger node outside the route machine fails closed"

# Коммит восстановления не получает интервала и обрывает его: простой между
# обрывом и подъёмом — не работа узла.
rec_attempt=$(begin_selected 68 a_fedcba9876543210fedcba9876543210)
assert_rc 0 "$?" "recovery work-time attempt is prepared"
ATTEMPT_STAGE_STATE_TIME_OVERRIDE='2026-01-01T00:00:00Z' \
  attempt_stage_state_init_v2 68 "$rec_attempt" debug >/dev/null
ATTEMPT_STAGE_STATE_TIME_OVERRIDE='2026-01-01T03:00:00Z' \
  attempt_stage_state_commit_v2 68 "$rec_attempt" instrument failed 0 "" 0 1 >/dev/null
assert_rc 0 "$?" "recovery commit closes the unrun node"
rec_wt=$(attempt_stage_state_work_time_v2 68 "$rec_attempt")
assert_rc 0 "$?" "work-time projection reads the recovery ledger"
assert_eq 0 "$("$NODE_BIN" -e \
  'const v=JSON.parse(process.argv[1]); process.stdout.write(String(Object.keys(v.nodes).length));' \
  "$rec_wt")" \
  "recovery commit gets no work interval"
assert_eq "$(date -u -d '2026-01-01 03:00:00' +%s)" "$(json_field "$rec_wt" lastEventAt)" \
  "lastEventAt still tracks the newest event"

legacy_after=$(sha256sum "$STATE_DIR/t51.pipeline" | awk '{print $1}')
assert_eq "$legacy_before" "$legacy_after" \
  "all stage-ledger operations leave legacy STATE_DIR byte-for-byte untouched"

finish_tests
