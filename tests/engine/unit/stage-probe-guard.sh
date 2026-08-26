#!/usr/bin/env bash
# Опыт проверяющего узла и превентивный сторож записи.
#
# Оба механизма появились из одного живого случая: проверяющий узел пять раз подряд
# получил отказ прав на проверку формы импорта, не смог ответить на собственный вопрос,
# вынес его БЛОКИРУЮЩИМ замечанием и остановил маршрут у человека. Человек ответил за три
# минуты — и ответил неверно, опираясь на комментарий в коде вместо запуска.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

guard="$FACTORY_HOME/lib/stage-write-guard.sh"
probe="$FACTORY_HOME/lib/stage-probe.sh"
state="$TEST_ROOT/state"
repo="$TEST_ROOT/work/probe-repo"

# --- сторож записи ---

# Решение хука: пустой вывод означает «решает обычный список прав».
decide() {
  printf '{"tool_input":{"command":%s}}' "$(printf '%s' "$1" | python3 -c \
    'import json,sys; print(json.dumps(sys.stdin.read()))')" |
    bash "$guard" "$state"
}

verdict_of() {
  local out
  out=$(decide "$1")
  if [[ -z "$out" ]]; then
    printf 'разрешено'
  else
    printf 'отказ'
  fi
}

# Запись в каталог состояния законна: `state-only` значит «дерево проекта только читаем»,
# а не «не пишем вовсе» — отчёт и черновик хода узел кладёт именно туда. Первая редакция
# правила этого не знала и отклоняла 342 команды из 3265 в замере по живым журналам.
assert_eq разрешено "$(verdict_of "cat >> $state/t1.review.checkpoint.md")" \
  "запись в каталог состояния разрешена"
assert_eq разрешено "$(verdict_of "git show HEAD:a.py > /tmp/head.py")" \
  "запись во временный каталог разрешена: это штатный способ сравнить файл с HEAD"
assert_eq разрешено "$(verdict_of 'ls -la 2>/dev/null; echo x')" \
  "перенаправление в /dev/null не является записью"
assert_eq разрешено "$(verdict_of 'cmd 2>&1 | head -5')" \
  "дублирование дескриптора не является записью"
assert_eq разрешено "$(verdict_of 'git status --short && echo "--- FE ---" && git status')" \
  "метка-разделитель ничего не пишет"
assert_eq разрешено "$(verdict_of 'grep -rn "a > b" src')" \
  "знак больше внутри кавычек — данные, а не оператор"

# Тот самый оплаченный инцидент: копия версии из HEAD, положенная В worktree, роняла узел
# посмертным сторожем уже ПОСЛЕ всей его работы. Теперь она не начнётся.
assert_eq отказ "$(verdict_of 'git show HEAD:a.php > /home/user/worktree/.head-check.bak')" \
  "запись в дерево проекта запрещена до исполнения"
assert_eq отказ "$(verdict_of 'echo x >> /home/user/worktree/file.txt')" \
  "дозапись в дерево проекта запрещена так же, как запись"

# Неразобранная команда — отказ, а не пропуск: пропустить неразобранное значит отдать
# рубеж целиком. Оболочка такую команду тоже не выполнит.
assert_eq отказ "$(verdict_of "docker exec c sh -c 'echo \"незакрытая")" \
  "команду, которую не разобрать, сторож не пропускает"

# Тело heredoc — данные. Без этого `stage-probe.sh --lang python` отказывал бы сам себе:
# сравнение `if a > b:` в теле выглядит голым оператором перенаправления.
assert_eq разрешено "$(verdict_of "$(printf 'bash probe.sh <<PY\nif a > b:\n    pass\nPY')")" \
  "сравнение внутри heredoc не считается перенаправлением"

# Событие не про Bash: команды нет, решать нечего.
assert_eq '' "$(printf '{"tool_input":{"file_path":"/x"}}' | bash "$guard" "$state")" \
  "сторож молчит на событии без команды"

# --- опыт ---

mkdir -p "$repo"
git -C "$repo" init -q 2>/dev/null
git -C "$repo" config user.email t@e >/dev/null 2>&1
git -C "$repo" config user.name t >/dev/null 2>&1
printf 'первая строка\n' >"$repo/file.txt"
git -C "$repo" add -A >/dev/null 2>&1
git -C "$repo" commit -qm init >/dev/null 2>&1

out=$(FACTORY_PROBE_ROOTS="$repo" bash "$probe" --lang python <<'PY'
print("итог", 2 + 2)
PY
)
assert_rc 0 $? "чистый опыт завершается кодом запуска"
assert_contains "$out" "итог 4" "опыт возвращает вывод кода"

# Опыт исполняется ВНЕ рабочего дерева: иначе относительная запись попала бы в проект.
out=$(FACTORY_PROBE_ROOTS="$repo" bash "$probe" --lang python <<'PY'
import os
print("cwd", os.getcwd())
PY
)
case "$out" in
  *"$repo"*) test_fail "рабочий каталог опыта лежит вне дерева проекта" "$out" ;;
  *) test_ok "рабочий каталог опыта лежит вне дерева проекта" ;;
esac

# Главный инвариант: опыт, изменивший дерево, недействителен целиком — вместе с выводом.
out=$(FACTORY_PROBE_ROOTS="$repo" bash "$probe" --lang python 2>&1 <<PY
open("$repo/new.txt", "w").write("x")
print("СЕКРЕТНЫЙ ВЫВОД")
PY
)
rc=$?
assert_rc 3 "$rc" "опыт, изменивший дерево, отвечает отдельным кодом"
assert_contains "$out" "ОПЫТ НЕДЕЙСТВИТЕЛЕН" "нарушение названо словами"
case "$out" in
  *"СЕКРЕТНЫЙ ВЫВОД"*)
    test_fail "вывод недействительного опыта не показывается" "$out" ;;
  *)
    test_ok "вывод недействительного опыта не показывается" ;;
esac

# Правка уже существующего отслеживаемого файла тоже видна: отпечаток сравнивает дифф
# рабочей копии, а не список изменённых имён — иначе правка грязного файла прошла бы мимо.
out=$(FACTORY_PROBE_ROOTS="$repo" bash "$probe" --lang python 2>&1 <<PY
open("$repo/file.txt", "a").write("дописано\n")
PY
)
assert_rc 3 $? "правка существующего файла тоже делает опыт недействительным"

git -C "$repo" checkout -q -- file.txt 2>/dev/null
rm -f "$repo/new.txt"

# Вход валидируется до запуска: язык из списка, непустой код.
FACTORY_PROBE_ROOTS="$repo" bash "$probe" --lang perl </dev/null >/dev/null 2>&1
assert_rc 2 $? "неизвестный язык опыта отклоняется"
printf '' | FACTORY_PROBE_ROOTS="$repo" bash "$probe" --lang python >/dev/null 2>&1
assert_rc 2 $? "пустой код опыта отклоняется"

# Питон берётся из venv проекта: в питон-проекте системный python3 не видит зависимостей,
# и опыт падал бы на импорте, не дойдя до проверяемого вопроса.
mkdir -p "$repo/.venv/bin"
printf '#!/bin/sh\necho ВЗЯТ-VENV\n' >"$repo/.venv/bin/python"
chmod +x "$repo/.venv/bin/python"
out=$(FACTORY_PROBE_ROOTS="$repo" bash "$probe" --lang python <<'PY'
print("не должно исполниться настоящим питоном")
PY
)
assert_contains "$out" "ВЗЯТ-VENV" "опыт предпочитает питон из venv проекта"

finish_tests
