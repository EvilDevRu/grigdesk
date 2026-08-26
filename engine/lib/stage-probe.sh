#!/usr/bin/env bash
# Read-only опыт для проверяющего узла.
#
# Проверяющий узел (`policy.filesystem = state-only`) не имеет права писать в рабочее
# дерево, и правами это выражено запретом инлайн-интерпретаторов: `python3 -c`, `node -e`,
# `php -r`. Запрет верный — однострочник умеет записать файл, а префиксное правило середину
# команды не читает. Но вместе с записью он отнимает и ЧТЕНИЕ: вопрос «а что на самом деле
# делает этот импорт» стало нечем проверить, и узел выносил его блокирующим замечанием.
#
# Замер, ради которого скрипт и появился: в одном заходе скептик пять раз подряд пробовал
# выяснить форму импорта общего модуля (`python -c "import ..."`), все пять раз получил
# отказ прав, эскалировал вопрос блокирующей находкой и остановил маршрут. Человек ответил
# на него за три минуты — и ответил НЕВЕРНО, опираясь на комментарий в коде вместо запуска.
# Проверить было дешевле, чем спросить.
#
# Инвариант тут один и он не про доверие: опыт не имеет права изменить рабочее дерево.
# Гарантируется он не запретом (интерпретатор всё равно умеет открыть файл на запись), а
# СВЕРКОЙ: отпечаток деревьев снимается до и после запуска, и расхождение делает результат
# опыта недействительным. Это тот же посмертный сторож, что стоит на узле целиком, только
# посмертие занимает секунды вместо сорока минут работы этапа.
#
# Отпечаток намеренно дешёвый (замер: 7-9 мс на репозиторий) и намеренно НЕ повторяет
# `workspace_guard_snapshot`: тот хеширует каждый untracked-файл поимённо и на больших
# деревьях занимает минуты — цена, допустимая четыре раза за транзакцию и недопустимая на
# каждый вызов опыта. Здесь достаточно трёх величин на дерево: дифф рабочей копии поверх
# HEAD, дифф индекса и список неотслеживаемых путей. Первые две ловят и правку уже грязного
# файла, третья — появление и исчезновение файлов.
#
# Чего отпечаток НЕ ловит и почему это принято: изменение СОДЕРЖИМОГО уже существующего
# неотслеживаемого файла (в списке путей оно не видно). Полный сторож узла его поймает,
# просто позже. Платить за это минутами на каждый вызов нельзя.
set -uo pipefail

FACTORY_HOME="$(cd "$(dirname "$0")/.." && pwd)"

PROBE_TIMEOUT_DEFAULT=120
PROBE_OUTPUT_LIMIT=16384

usage() {
  cat >&2 <<'EOF'
stage-probe.sh --lang python|node|php|sh [--timeout <сек>] [--code <текст>]

Код читается со stdin, если не задан --code. Рабочий каталог опыта — одноразовый
временный каталог ВНЕ рабочего дерева; писать в дерево проекта опыт не имеет права.
EOF
}

lang="" code="" timeout_s="$PROBE_TIMEOUT_DEFAULT" have_code=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --lang) lang=${2:-}; shift 2 ;;
    --timeout) timeout_s=${2:-}; shift 2 ;;
    --code) code=${2:-}; have_code=1; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    --) shift; break ;;
    *) printf 'stage-probe: неизвестный аргумент %s\n' "$1" >&2; usage; exit 2 ;;
  esac
done

case "$lang" in
  python|node|php|sh) ;;
  *) printf 'stage-probe: --lang обязателен: python|node|php|sh\n' >&2; exit 2 ;;
esac
[[ "$timeout_s" =~ ^[1-9][0-9]{0,3}$ ]] || {
  printf 'stage-probe: --timeout должен быть целым числом секунд (1..9999)\n' >&2
  exit 2
}
if (( have_code == 0 )); then
  code=$(cat)
fi
[[ -n "${code//[[:space:]]/}" ]] || {
  printf 'stage-probe: пустой код опыта\n' >&2
  exit 2
}

# Корни, которые опыт обязан оставить нетронутыми. Их называет движок при запуске узла
# (`FACTORY_PROBE_ROOTS`); при пустом значении берём репозиторий текущего каталога —
# cwd агента это worktree задачи, то есть ровно то дерево, которое он может испортить.
declare -a roots=()
if [[ -n "${FACTORY_PROBE_ROOTS:-}" ]]; then
  read -r -a roots <<<"${FACTORY_PROBE_ROOTS}"
fi
if (( ${#roots[@]} == 0 )); then
  roots=("$PWD")
fi

# Отпечаток одного дерева: три величины, каждая одним вызовом git. `--binary` нужен,
# чтобы правка бинарного файла не выглядела пустым диффом; `--no-ext-diff` — чтобы
# пользовательский внешний diff не подменил результат.
_probe_fingerprint() {
  local candidate root head
  for candidate in "${roots[@]}"; do
    [[ -d "$candidate" ]] || continue
    root=$(git -C "$candidate" rev-parse --show-toplevel 2>/dev/null) || continue
    head=$(git -C "$root" rev-parse --verify HEAD 2>/dev/null || printf 'UNBORN')
    printf 'ROOT\t%s\tHEAD\t%s\n' "$root" "$head"
    if [[ "$head" == UNBORN ]]; then
      printf 'WORKTREE\t%s\t%s\n' "$root" \
        "$(git -C "$root" diff --binary --no-ext-diff -- | sha256sum | cut -d' ' -f1)"
    else
      printf 'WORKTREE\t%s\t%s\n' "$root" \
        "$(git -C "$root" diff --binary --no-ext-diff HEAD -- | sha256sum | cut -d' ' -f1)"
    fi
    printf 'INDEX\t%s\t%s\n' "$root" \
      "$(git -C "$root" diff --cached --binary --no-ext-diff -- | sha256sum | cut -d' ' -f1)"
    printf 'UNTRACKED\t%s\t%s\n' "$root" \
      "$(git -C "$root" ls-files --others --exclude-standard -z |
           sort -z | sha256sum | cut -d' ' -f1)"
  done
}

before=$(_probe_fingerprint)

workdir=$(mktemp -d "${TMPDIR:-/tmp}/factory-probe.XXXXXX") || {
  printf 'stage-probe: не удалось создать временный каталог\n' >&2
  exit 1
}
cleanup() {
  rm -rf -- "$workdir"
}
trap cleanup EXIT

# Интерпретатор. Для python предпочитаем venv проекта: в питон-проекте системный python3
# не видит зависимостей, и опыт падал бы на импорте, не дойдя до проверяемого вопроса.
# Ищем по корням, а не по имени профиля: имя придумывает человек, а каталог существует.
_probe_python() {
  local candidate root name
  for candidate in "${roots[@]}"; do
    [[ -d "$candidate" ]] || continue
    root=$(git -C "$candidate" rev-parse --show-toplevel 2>/dev/null) || root="$candidate"
    for name in .venv venv; do
      if [[ -x "$root/$name/bin/python" ]]; then
        printf '%s\n' "$root/$name/bin/python"
        return 0
      fi
    done
  done
  printf 'python3\n'
}

script="$workdir/probe"
printf '%s\n' "$code" >"$script" || exit 1

declare -a argv=()
case "$lang" in
  python) argv=("$(_probe_python)" "$script") ;;
  node)   argv=(node "$script") ;;
  php)    argv=(php "$script") ;;
  sh)     argv=(bash "$script") ;;
esac

output=$(cd "$workdir" && timeout --signal=TERM --kill-after=5 "$timeout_s" \
  "${argv[@]}" 2>&1)
rc=$?

after=$(_probe_fingerprint)

if [[ "$before" != "$after" ]]; then
  # Опыт изменил рабочее дерево. Результат недействителен целиком: узел объявлен
  # проверяющим, и вывод команды, которая уже нарушила его границу, доказательством
  # быть не может. Печатаем ЧТО именно разошлось — но только имена деревьев и вид
  # расхождения: содержимое диффа наружу не идёт.
  {
    printf 'stage-probe: ОПЫТ НЕДЕЙСТВИТЕЛЕН — он изменил рабочее дерево.\n'
    printf 'Проверяющий узел не имеет права писать в дерево проекта. Расхождения:\n'
    diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") |
      awk '/^[<>]/ {print "  " $1 " " $2 " " $3}' | sort -u | head -20
    printf 'Вывод опыта не показан. Повтори опыт так, чтобы он только читал.\n'
  } >&2
  exit 3
fi

if (( ${#output} > PROBE_OUTPUT_LIMIT )); then
  printf '%s\n' "${output:0:PROBE_OUTPUT_LIMIT}"
  printf '\n[stage-probe: вывод обрезан до %s символов]\n' "$PROBE_OUTPUT_LIMIT"
else
  printf '%s\n' "$output"
fi

if (( rc == 124 || rc == 137 )); then
  printf '[stage-probe: опыт прерван по лимиту %s с]\n' "$timeout_s" >&2
fi
exit "$rc"
