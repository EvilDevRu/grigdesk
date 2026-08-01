#!/usr/bin/env python3
"""Схема маршрута на дашборде обязана совпадать с реальными этапами профиля.

Именно рассинхрон (этапы правили в профиле, а граф остался общим) дал «кашу»:
в feature рисовались узлы debug-маршрута. Проверка ловит это до того, как увидит человек.

Запуск: python3 tests/engine/routes-sync.py <профиль>
"""
import importlib.util
import os
import re
import subprocess
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HOME = os.environ.get('FACTORY_HOME', os.path.join(PROJECT_ROOT, 'engine'))
PROFILES = os.environ.get('FACTORY_PROFILES_DIR', os.path.join(PROJECT_ROOT, 'profiles'))
PROFILE = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('FACTORY_PROFILE', '')
if not PROFILE:
    print('профиль обязателен: передайте аргумент или FACTORY_PROFILE', file=sys.stderr)
    sys.exit(2)

spec = importlib.util.spec_from_file_location('dash', f'{HOME}/lib/dashboard.py')
dash = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dash)

# Этап реестра → узлы схемы. Один этап может рисоваться несколькими узлами
# (PLAN = дуэль планов + скептик + валидация + переводчик; BUILD = сборка + симплифаер).
# Этап → узлы схемы. По умолчанию узел = lower(этап); отклонения профиль объявляет в
# graph.json (keys) — здесь достаточно перечислить случаи «один этап рисуется НЕСКОЛЬКИМИ
# узлами» (например, PLAN может включать планы, скептика, валидацию и переводчика).
# SPLIT — ФОЛБЭК для профилей, не объявивших этап в keys: объявленное в graph.json главнее
# (иначе эта четвёрка узлов требовалась бы от ЛЮБОГО профиля с этапом PLAN; простой
# профиль может объявить один узел явной строкой keys {"plan": "PLAN"}).
SPLIT = {'PLAN': ['plan', 'skeptic', 'validate', 'translator']}
# Узлы вне конвейера этапов: их ставит сам движок (не профиль). Это подъём стенда и хвост
# после конвейера — ENGINE_TAIL_KEYS в lib/dashboard.py. Список должен покрывать хвост
# целиком: любой непокрытый узел выглядит как «лишний на схеме» и валит проверку на ровном
# месте. Демо-узлов здесь нет намеренно: демо снимается вне конвейера (кнопка плагина
# «Демо» в кокпите), и на схеме маршрута ему делать нечего.
ENGINE_NODES = {'sandbox', 'ship', 'retro'}
# Хвост может рисоваться на схеме, но не должен входить в PROFILE_ROUTE_STAGES_*:
# bin/factory запускает его сам после успешного run_pipeline.
ENGINE_TAIL_STAGES = {'SHIP', 'RETRO'}
# Старые demo-ворота удалены из runtime. Их возврат в граф снова покажет человеку
# несуществующую часть конвейера.
OBSOLETE_GRAPH_NODES = {'demo', 'gate_demo', 'gate_demo_ok'}
# Спутники этапа: рисуются НЕ везде (в коротких маршрутах диффы мелкие — симплифаер не нужен).
# Допустимы, если их родительский этап в маршруте есть; их отсутствие ошибкой не считается.
SATELLITES = {
    'simplify': 'BUILD',
    # Тест-критика выполняет тот же агент внутри TESTS и публикует отдельный статус
    # для наглядности; отдельного запуска TCRITIC в маршруте быть не должно.
    'tcritic': 'TESTS',
}

# Этапы маршрутов читаем у профиля — источник истины именно он.
out = subprocess.run(
    ['bash', '-c',
     f'source {PROFILES}/{PROFILE}/profile.sh 2>/dev/null\n'
     'for v in $(compgen -A variable | grep "^PROFILE_ROUTE_STAGES_"); do\n'
     '  n="$v[@]"; echo "${v#PROFILE_ROUTE_STAGES_} ${!n}"\n'
     'done'],
    capture_output=True, text=True).stdout

profile_routes = {}
for line in out.split('\n'):
    parts = line.split()
    if len(parts) > 1:
        profile_routes[parts[0]] = parts[1:]

fails, notes = [], []
if not profile_routes:
    fails.append(f'профиль {PROFILE}: не прочитались PROFILE_ROUTE_STAGES_*')

for route, stages in profile_routes.items():
    for stage in sorted(ENGINE_TAIL_STAGES.intersection(stages)):
        fails.append(
            f'{route}: {stage} ошибочно включён в маршрут — это хвост движка после GATE_ACCEPT')
    g = dash.profile_graphs(PROFILE).get(route)
    if not g:
        notes.append(f'{route}: своей схемы нет — дашборд нарисует автосхему из этапов')
        continue
    drawn = set(g['pos'])
    for n in sorted(drawn.intersection(OBSOLETE_GRAPH_NODES)):
        fails.append(f'{route}: на схеме остался устаревший demo-узел — {n}')
    # какой узел отвечает за этап: сперва объявленное в graph.json (keys), затем lower(этап)
    by_key = {}
    for node, key in dash.profile_graph_meta(PROFILE)['keys'].items():
        by_key.setdefault(key, []).append(node)
    expected = {n for st in stages for n in (by_key.get(st) or SPLIT.get(st) or [st.lower()])}
    for n in sorted(expected - drawn):
        fails.append(f'{route}: этап есть в профиле, а узла на схеме нет — {n}')
    for n in sorted(drawn - expected - ENGINE_NODES):
        parent = SATELLITES.get(n)
        if parent and parent in stages:
            continue
        fails.append(f'{route}: на схеме лишний узел (в маршруте такого этапа нет) — {n}')

for route, g in dash.profile_graphs(PROFILE).items():
    if route not in profile_routes:
        fails.append(f'{route}: схема есть, а маршрута в профиле нет')
    for src, dst, *_ in g['edges']:
        for n in (src, dst):
            if n != '_start' and n not in g['pos']:
                fails.append(f'{route}: ребро ведёт в чужой узел {n}')

for n in notes:
    print('⚠ ' + n)
if fails:
    print('\n'.join('✗ ' + f for f in fails))
    sys.exit(1)
print(f'✓ схемы совпадают с этапами профиля {PROFILE}: ' +
      ', '.join(f'{r} ({len(s)} этапов)' for r, s in sorted(profile_routes.items())))
