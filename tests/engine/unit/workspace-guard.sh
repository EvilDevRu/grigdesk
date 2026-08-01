#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/workspace-guard.sh"

repo="$TEST_ROOT/work/repo"
mkdir -p "$repo"
git -C "$repo" init -q
git -C "$repo" config user.name fixture
git -C "$repo" config user.email fixture@example.test

printf 'исходное\n' >"$repo/tracked.txt"
printf 'индекс\n' >"$repo/staged.txt"
printf 'ignored-*\n' >"$repo/.gitignore"
git -C "$repo" add tracked.txt staged.txt .gitignore
git -C "$repo" commit -qm baseline

# Baseline намеренно уже грязный: сторож обязан заметить повторную правку того же пути,
# а не только появление нового имени в `git status`.
printf 'грязное до этапа\n' >"$repo/tracked.txt"
printf 'в индексе до этапа\n' >"$repo/staged.txt"
git -C "$repo" add staged.txt
printf 'временный до этапа\n' >"$repo/untracked file.txt"
ln -s 'untracked file.txt' "$repo/untracked-link"
printf 'секрет до этапа\n' >"$repo/ignored-secret"
printf 'runtime до этапа\n' >"$repo/ignored-runtime"

sensitive="$TEST_ROOT/sensitive.list"
printf '%s\n' "$repo/ignored-secret" >"$sensitive"
export WORKSPACE_GUARD_SENSITIVE_LIST_FILE="$sensitive"

before="$TEST_ROOT/before.tsv"
same="$TEST_ROOT/same.tsv"
workspace_guard_snapshot "$before" "$repo"
assert_rc 0 "$?" "baseline captures a dirty repository"
workspace_guard_snapshot "$same" "$repo/subdir-does-not-exist" "$repo"
assert_rc 0 "$?" "invalid candidates do not hide a valid root"
workspace_guard_compare "$before" "$same"
assert_rc 0 "$?" "identical dirty state has a stable snapshot"

printf 'грязное изменено этапом\n' >"$repo/tracked.txt"
after="$TEST_ROOT/after-tracked.tsv"
workspace_guard_snapshot "$after" "$repo"
workspace_guard_compare "$before" "$after"
assert_rc 1 "$?" "content change of an already dirty tracked file is detected"
mv -- "$same" "$before"

printf 'индекс изменён этапом\n' >"$repo/staged.txt"
git -C "$repo" add staged.txt
workspace_guard_snapshot "$after" "$repo"
workspace_guard_compare "$before" "$after"
assert_rc 1 "$?" "index content change is detected"
workspace_guard_snapshot "$before" "$repo"

printf 'существующий untracked изменён\n' >"$repo/untracked file.txt"
workspace_guard_snapshot "$after" "$repo"
workspace_guard_compare "$before" "$after"
assert_rc 1 "$?" "content change of an existing untracked file is detected"
workspace_guard_snapshot "$before" "$repo"

chmod 700 "$repo/untracked file.txt"
workspace_guard_snapshot "$after" "$repo"
workspace_guard_compare "$before" "$after"
assert_rc 1 "$?" "mode change of an untracked file is detected"
workspace_guard_snapshot "$before" "$repo"

ln -sfn tracked.txt "$repo/untracked-link"
workspace_guard_snapshot "$after" "$repo"
workspace_guard_compare "$before" "$after"
assert_rc 1 "$?" "symlink target change is detected"
workspace_guard_snapshot "$before" "$repo"

printf 'секрет изменён этапом\n' >"$repo/ignored-secret"
workspace_guard_snapshot "$after" "$repo"
workspace_guard_compare "$before" "$after"
assert_rc 1 "$?" "declared sensitive ignored file is detected by hash"
workspace_guard_snapshot "$before" "$repo"

printf 'обычный runtime изменился\n' >"$repo/ignored-runtime"
workspace_guard_snapshot "$after" "$repo"
workspace_guard_compare "$before" "$after"
assert_rc 0 "$?" "ordinary ignored runtime artifacts stay outside the baseline"

scope="$TEST_ROOT/scope.list"
printf '%s\n' "$repo/tracked.txt" >"$scope"
workspace_guard_snapshot "$before" "$repo"
printf 'разрешённое изменение транзакции\n' >"$repo/tracked.txt"
workspace_guard_snapshot "$after" "$repo"
workspace_guard_compare_scoped "$before" "$after" "$scope"
assert_rc 0 "$?" "scoped comparison accepts a change owned by the transaction"

printf 'изменение вне scope\n' >"$repo/staged.txt"
workspace_guard_snapshot "$after" "$repo"
workspace_guard_compare_scoped "$before" "$after" "$scope"
assert_rc 1 "$?" "scoped comparison rejects a change outside the transaction"

# --- сама запись, а не только сравнение снимков ---
# Записи собираются пачкой (один процесс на весь список): пофайловая сборка стоила 5-6 форков
# на файл и 19 минут на 72 778 путях приёмочного прогона t8165. Ниже — два места, где пакетная
# сборка могла бы разойтись с прежней, и оба стоили бы дороже сэкономленного времени.

# Имя с переводом строки: sha256sum экранирует ТАКУЮ строку вывода ведущим `\`, и прежний
# `awk '{print $1}'` приклеивал слэш к хешу — в поле оказывалось 65 символов вместо 64.
# Врали обе стороны сравнения одинаково, поэтому ошибку не ловил ни один снимок.
printf 'имя с переводом строки\n' >"$repo/$(printf 'untracked\nnewline.txt')"
workspace_guard_snapshot "$after" "$repo"
broken=$(awk -F'\t' '$1 == "UNTRACKED" && $6 !~ /^[0-9a-f]{64}$/ {print $3}' "$after")
assert_eq "" "$broken" "хеш записи — ровно 64 hex-символа при любом имени файла"

# Вложенный репозиторий обязан остаться СВОИМ корнем. Корень ищется обходом каталогов вверх
# с кешем (git зовётся раз на репозиторий, а не раз на файл), и соблазн приписать файл
# внешнему worktree ломал бы scope-сравнение: разрешённая правка перестала бы узнаваться.
mkdir -p "$repo/ignored-vendor/nested"
git -C "$repo/ignored-vendor/nested" init -q
printf 'внутри вложенного\n' >"$repo/ignored-vendor/nested/inner.txt"
printf '%s\n' "$repo/ignored-vendor/nested/inner.txt" >>"$sensitive"
workspace_guard_snapshot "$after" "$repo"
nested_root=$(printf '%s' "$(git -C "$repo/ignored-vendor/nested" rev-parse --show-toplevel)" | base64 -w0)
nested_rel=$(printf '%s' inner.txt | base64 -w0)
if grep -qF "$(printf 'SENSITIVE\t%s\t%s\tfile' "$nested_root" "$nested_rel")" "$after"; then
  test_ok "файл вложенного репозитория записан под его собственным корнем"
else
  test_fail "файл вложенного репозитория записан под его собственным корнем" \
    "$(grep -F "$nested_rel" "$after" || printf 'записи нет вовсе')"
fi

summary=$(workspace_guard_diff_summary "$before" "$after" 2>/dev/null || true)
if [[ "$summary" != *"секрет изменён"* && "$summary" != *"грязное изменено"* ]]; then
  test_ok "diff summary does not disclose file contents"
else
  test_fail "diff summary does not disclose file contents" "$summary"
fi

# Сводка для журнала: раскодированные каталоги вместо base64. Fail-closed писал одну
# строку «код 75», и понять, из-за чего встала приёмка t8165, можно было только руками
# разобрав снимки транзакции.
paths=$(workspace_guard_diff_paths "$before" "$after" 12)
assert_rc 0 "$?" "diff paths summarises a real difference"
assert_contains "$paths" "$repo" "сводка называет каталог, а не base64"
if [[ "$paths" != *"секрет изменён"* && "$paths" != *"грязное изменено"* ]]; then
  test_ok "diff paths does not disclose file contents"
else
  test_fail "diff paths does not disclose file contents" "$paths"
fi
capped=$(workspace_guard_diff_paths "$before" "$after" 1)
assert_eq 2 "$(printf '%s\n' "$capped" | wc -l)" "сводка обрезана лимитом"
assert_contains "$capped" "и ещё каталогов:" "обрезанная сводка честно говорит об остатке"

# Нечитаемый файл — пустое поле хеша, а не провал снимка: контейнеры стенда пишут
# в рабочее дерево от своего пользователя, и снимок обвалился бы в snapshot_failed.
# Прежний конвейер `sha256sum | awk` вёл себя ровно так же (код возврата брался у awk).
if [[ $EUID -ne 0 ]]; then
  printf 'чужой файл\n' >"$repo/ignored-foreign"
  chmod 000 "$repo/ignored-foreign"
  printf '%s\n' "$repo/ignored-foreign" >>"$sensitive"
  workspace_guard_snapshot "$after" "$repo"
  assert_rc 0 "$?" "unreadable sensitive file does not fail the snapshot"
  foreign_rel=$(printf '%s' ignored-foreign | base64 -w0)
  assert_contains "$(awk -F'\t' -v p="$foreign_rel" '$3 == p {print $1 "|" $6 "|"}' "$after")" \
    "SENSITIVE||" "запись нечитаемого файла есть, хеш пустой"
  chmod 644 "$repo/ignored-foreign"
fi

finish_tests
