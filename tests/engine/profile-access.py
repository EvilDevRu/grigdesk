#!/usr/bin/env python3
"""Проверка: агент сможет писать туда, куда его посылает профиль.

Песочница Claude Code режет запись за пределы рабочего каталога агента. Если профиль
велит писать в путь, который не покрыт ни cwd, ни PROFILE_AGENT_DIRS, ни STATE_DIR —
агент отработает этап целиком и упрётся в отказ на последнем шаге. Движок при этом
увидит «статус не выставлен» и запустит этап заново, тратя повторные заходы впустую.

Проверка статическая: собирает хостовые пути из промптов всех этапов всех маршрутов
и сверяет с выданным доступом.

Запуск: python3 tests/engine/profile-access.py [профиль ...]   (без аргументов — все профили)
"""
import os
import re
import subprocess
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HOME = os.environ.get('FACTORY_HOME', os.path.join(PROJECT_ROOT, 'engine'))
PROFILES = os.environ.get('FACTORY_PROFILES_DIR', os.path.join(PROJECT_ROOT, 'profiles'))
STATE_DIR = os.environ.get('FACTORY_STATE', os.path.expanduser('~/.factory/state'))
TASK = '9999'   # фиктивный номер: промпты подставляют его в пути worktree

profiles = sys.argv[1:] or sorted(
    name for name in os.listdir(PROFILES)
    if os.path.isfile(os.path.join(PROFILES, name, 'profile.sh')))

# Пути внутри контейнеров и системные — не про доступ агента на хосте.
HOST_PREFIX = ('/home/', '/tmp/')


def bash(script):
    return subprocess.run(['bash', '-c', script], capture_output=True, text=True).stdout


def profile_dump(profile):
    """Промпты всех этапов + объявленный доступ (одним заходом в bash)."""
    script = f'''
export STATE_DIR="{STATE_DIR}"
source "{HOME}/lib/core.sh" 2>/dev/null
source "{PROFILES}/{profile}/profile.sh" 2>/dev/null
echo "@@CWD $PROFILE_AGENT_CWD"
echo "@@DIRS $PROFILE_AGENT_DIRS"
for v in $(compgen -A variable | grep "^PROFILE_ROUTE_STAGES_"); do
  n="$v[@]"
  for s in ${{!n}}; do
    echo "@@STAGE $s"
    profile_stage_prompt "{TASK}" "$s" 2>/dev/null
  done
done
'''
    return bash(script)


fails, notes = [], []
for profile in profiles:
    out = profile_dump(profile)
    if '@@CWD' not in out:
        fails.append(f'{profile}: профиль не читается (ошибка в bash-синтаксисе?)')
        continue

    cwd = re.search(r'@@CWD (.*)', out).group(1).strip()
    dirs = re.search(r'@@DIRS (.*)', out).group(1).strip().split()
    # HOME движка доступен для scoped stage-result/stage-progress и служебных файлов.
    allowed = [p for p in [cwd, STATE_DIR, HOME, *dirs] if p]

    if cwd and not os.path.isdir(cwd):
        fails.append(f'{profile}: рабочий каталог агента не существует — {cwd}')
    for dd in dirs:
        if not os.path.isdir(dd):
            notes.append(f'{profile}: объявленный каталог пока не существует — {dd}')

    # какие пути профиль называет агенту
    paths = set()
    for m in re.finditer(r'(?<![\w=])(/[\w./-]{6,})', out):
        p = m.group(1).rstrip('.,;:)»"\'')
        if p.startswith(HOST_PREFIX):
            paths.add(p)

    uncovered = sorted(p for p in paths
                       if not any(p == a or p.startswith(a.rstrip('/') + '/') for a in allowed))
    # /tmp агенту доступен всегда, это не ошибка доступа
    uncovered = [p for p in uncovered if not p.startswith('/tmp/')]

    if uncovered:
        for p in uncovered[:8]:
            fails.append(f'{profile}: промпт шлёт агента в {p}, а доступа туда нет '
                         f'(добавь в PROFILE_AGENT_DIRS)')
    else:
        print(f'✓ {profile}: все пути промптов покрыты доступом '
              f'(cwd={cwd or "—"}, доп. каталогов: {len(dirs)})')

for n in notes:
    print('⚠ ' + n)
if fails:
    print('\n'.join('✗ ' + f for f in fails))
    sys.exit(1)
print('ИТОГ: доступ профилей в порядке')
