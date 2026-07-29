#!/usr/bin/env python3
"""
Живой дашборд песочниц и конвейера фабрики Arsenkin.
Собирает состояние на каждый GET (docker/redis/git/реестры) и отдаёт HTML
с авто-обновлением каждые 5 секунд. Конвейер задачи рисуется SVG-графом
с подсветкой активных узлов. Только stdlib.
Запуск: dashboard.sh [порт]  (по умолчанию 8070)
"""
import html
import http.server
import json
import os
import re
import subprocess
import sys
import time

# Движок: STATE_DIR — где реестры задач (общий для всех профилей).
STATE_DIR = os.environ.get('FACTORY_STATE', os.path.expanduser('~/.factory/state'))
# Проектные пути/контейнеры/трекер — из env (задаёт профиль через systemd/env-файл).
# Дефолты — arsenkin, чтобы текущий стенд работал без настройки.
BE = os.environ.get('FACTORY_BE_ROOT', '/home/evildev/Workspace/arsenkin/be')
FE = os.environ.get('FACTORY_FE_ROOT', '/home/evildev/Workspace/arsenkin/fe')
DATA_MYSQL = os.environ.get('FACTORY_MYSQL_CONTAINER', 'arsenkin-mysql-1')
DATA_REDIS = os.environ.get('FACTORY_REDIS_CONTAINER', 'arsenkin-redis-1')
SB_PREFIX = os.environ.get('FACTORY_SANDBOX_PREFIX', 'ars-sb-t')     # +TASK-application-1
TIMER_CMD = os.environ.get('FACTORY_TIMER_CMD', '')                  # трекер времени задачи (опц.)
STALL_SEC = 15 * 60  # этап без прогресса дольше 15 минут = «застряла»
# Флаг сторожа: tmpfs, поэтому исчезает при перезагрузке — после ребута фабрика не оживает сама


# --- Проектные параметры берутся ПО ПРОФИЛЮ ЗАДАЧИ ---------------------------------
# На фабрике живут задачи РАЗНЫХ проектов одновременно (#7900 — arsenkin, #101 — rdesigner).
# Глобальные значения выше — лишь дефолт «профиль не указан»; всё, что зависит от проекта
# (где worktree, как называется контейнер стенда, есть ли трекер), читается из
# profiles/<профиль>/dashboard.env для конкретной задачи.
_prof_env_cache = {}


def prof_env(profile):
    """Параметры проекта по имени профиля (кэш). Пустой профиль — глобальные дефолты."""
    if profile in _prof_env_cache:
        return _prof_env_cache[profile]
    env = {
        'BE': BE, 'FE': FE, 'MYSQL': DATA_MYSQL, 'REDIS': DATA_REDIS,
        'SB_PREFIX': SB_PREFIX, 'TIMER': TIMER_CMD,
        'STAND': '', 'STAND_FE': '', 'STAND_URL': '',
    }
    path = os.path.join(PROFILES_DIR, profile, 'dashboard.env')
    if profile and os.path.exists(path):
        raw = {}
        for k, v in parse_env_file(path).items():
            raw[k] = v.strip().strip('"').strip("'")   # значения с пробелом пишутся в кавычках
        env.update({
            'BE': raw.get('FACTORY_BE_ROOT', BE), 'FE': raw.get('FACTORY_FE_ROOT', FE),
            'MYSQL': raw.get('FACTORY_MYSQL_CONTAINER', DATA_MYSQL),
            'REDIS': raw.get('FACTORY_REDIS_CONTAINER', DATA_REDIS),
            'SB_PREFIX': raw.get('FACTORY_SANDBOX_PREFIX', SB_PREFIX),
            'TIMER': raw.get('FACTORY_TIMER_CMD', ''),
            'STAND': raw.get('FACTORY_STAND_CONTAINER', ''),
            'STAND_FE': raw.get('FACTORY_STAND_FE_CONTAINER', ''),
            'STAND_URL': raw.get('FACTORY_STAND_URL', ''),
        })
    _prof_env_cache[profile] = env
    return env


def task_profile(task):
    """Профиль проекта из реестра задачи ('' — задача заведена без профиля)."""
    return parse_env_file(f'{STATE_DIR}/t{task}.pipeline').get('PROFILE', '')


def stand_containers(profile, task):
    """Имена контейнеров стенда: шаблон профиля ({task} — на задачу, без него — общий стенд)."""
    pe = prof_env(profile)
    if pe['STAND']:
        return pe['STAND'].replace('{task}', task), pe['STAND_FE'].replace('{task}', task)
    return f'{pe["SB_PREFIX"]}{task}-application-1', f'{pe["SB_PREFIX"]}{task}-frontend-1'


def run(cmd, timeout=4):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip()
    except Exception:
        return ''


def docker_state(name):
    return run(['docker', 'inspect', '-f', '{{.State.Status}}', name]) or ''


def redis_cli(n, *args):
    return run(['docker', 'exec', DATA_REDIS, 'redis-cli', '-n', str(n), *args])


def git_info(wt):
    br = run(['git', '-C', wt, 'branch', '--show-current'])
    dirty = run(['git', '-C', wt, 'status', '--porcelain'])
    return br, len(dirty.splitlines()) if dirty else 0


def queue_depths(n):
    keys = redis_cli(n, '--scan', '--pattern', '_database_queue:*').splitlines()
    res = []
    for k in keys:
        if ':reserved' in k or ':delayed' in k or k.endswith(':notify'):
            continue
        depth = redis_cli(n, 'llen', k)
        if depth.isdigit() and int(depth) > 0:
            res.append((k.split(':', 1)[1], int(depth)))
    return sorted(res, key=lambda x: -x[1])


def parse_env_file(path):
    out = {}
    try:
        with open(path, encoding='utf-8') as f:
            for line in f:
                if '=' in line and not line.startswith('#'):
                    k, v = line.rstrip('\n').split('=', 1)
                    out[k] = v
    except OSError:
        pass
    return out


def collect_sandboxes():
    tasks = set()
    for f in os.listdir(STATE_DIR) if os.path.isdir(STATE_DIR) else []:
        m = re.match(r'^t(\d+)\.(env|stage|pipeline)$', f)
        if m:
            tasks.add(m.group(1))
    boxes = []
    # Порядок карточек ДОЛЖЕН быть детерминированным и не зависеть от статуса:
    # сортировка по статусу («активные сверху») заставляла карточки прыгать при каждом
    # изменении этапа. Числовой порядок по номеру задачи стабилен всегда.
    for task in sorted(tasks, key=lambda t: (len(t), t)):
        stage_path = f'{STATE_DIR}/t{task}.stage'
        state = parse_env_file(f'{STATE_DIR}/t{task}.env')
        stages, stage_age = [], None
        if os.path.exists(stage_path):
            with open(stage_path, encoding='utf-8') as f:
                stages = [s.strip() for s in f if s.strip()]
            stage_age = time.time() - os.path.getmtime(stage_path)
        last = stages[-1] if stages else ''
        done = last.endswith('|DONE')
        # up.sh помечает падение через trap: краснеем сразу, не ожидая STALL_SEC
        failed = last.split('|')[1:2] == ['FAILED']
        profile = task_profile(task)
        c_app, c_fe = stand_containers(profile, task)
        app = docker_state(c_app)
        fe_c = docker_state(c_fe) if c_fe else ''

        if failed:
            status = 'stall'
        elif not done and stage_age is not None and stage_age < STALL_SEC:
            status = 'up'
        elif not done and stages:
            status = 'stall'
        elif app == 'running':
            status = 'run'
        else:
            status = 'down'

        info = {
            'task': task, 'profile': profile, 'status': status, 'stages': stages, 'app_name': c_app,
            'stage_age': stage_age, 'app': app, 'fe': fe_c, 'state': state,
            'branch': '', 'dirty': 0, 'queues': [], 'horizon': False,
        }
        wt = state.get('BE_WT') or f'{prof_env(profile)["BE"]}/worktree-t{task}'
        if os.path.isdir(wt):
            info['branch'], info['dirty'] = git_info(wt)
        if status == 'run' and state.get('REDIS_N'):
            info['queues'] = queue_depths(state['REDIS_N'])
            info['horizon'] = redis_cli(state['REDIS_N'], 'exists', '_database_masters') == '1'
        boxes.append(info)
    return boxes


def collect_orphan_schemas(known_tasks):
    q = ("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE "
         "SCHEMA_NAME LIKE 'db\\_t%' OR SCHEMA_NAME LIKE 'tools\\_t%' "
         "OR (SCHEMA_NAME LIKE 'user\\_db\\_21%' AND LENGTH(SCHEMA_NAME) >= 18)")
    out = run(['docker', 'exec', DATA_MYSQL, 'mysql', '-uroot', '-proot', '-N', '-e', q], timeout=6)
    orphans = []
    for s in out.splitlines():
        task = None
        m1 = re.match(r'^(?:db|tools)_t(\d+)$', s)
        m2 = re.match(r'^user_db_(\d+)$', s)
        if m1:
            task = m1.group(1)
        elif m2 and int(m2.group(1)) >= 2100000000:
            task = str(int(m2.group(1)) - 2100000000)
        if task and task not in known_tasks:
            orphans.append(s)
    return orphans


def collect_slots():
    # Проектные слоты публикуются через `factory slots`/profile_slots, а не из движка.
    return []


# ---------- Конвейер фабрики: статусы узлов ----------

# Кумулятивные пороги завершённых агентов workflow №1 (фазы с барьерами):
# 3 скаута -> 2 плана -> 1 скептик -> 1 валидация
WF1_THRESHOLDS = [('scout', 3), ('plan', 5), ('skeptic', 6), ('validate', 7), ('translator', 8)]


def journal_result_count(path):
    n = 0
    try:
        with open(path, encoding='utf-8') as f:
            for line in f:
                if '"type":"result"' in line or '"type": "result"' in line:
                    n += 1
    except OSError:
        pass
    return n


def pipeline_last_move(task, pf):
    """Время последнего «движения» конвейера: записи агентов, реестр, журнал этапов."""
    cands = [f'{STATE_DIR}/t{task}.pipeline', f'{STATE_DIR}/t{task}.stage',
             f'{STATE_DIR}/logs/t{task}.orch.log']
    adir = pf.get('ACTIVE_DIR', '') or os.path.dirname(pf.get('JOURNAL', ''))
    if adir and os.path.isdir(adir):
        cands += [os.path.join(adir, f) for f in os.listdir(adir) if f.endswith('.jsonl')]
    mtimes = [os.path.getmtime(p) for p in cands if os.path.exists(p)]
    return max(mtimes) if mtimes else None


STALL_SOFT_SEC = 5 * 60    # живой агент пишет каждые секунды: 5 мин тишины = «тихо»
STALL_HARD_SEC = 15 * 60   # 15 мин = завис (красный + нотификация)


def pipeline_stall(task, pf, st):
    """(минуты, 'soft'|'hard') если конвейер не движется при заявленной работе; иначе None."""
    if any(s == 'wait' for s in st.values()):
        return None
    if pf.get('RETRO') == 'done' or pf.get('SHIP') == 'done':
        return None
    claimed = pf.get('WF_STATUS') == 'running' or 'running' in pf.values()
    if not claimed:
        return None
    last = pipeline_last_move(task, pf)
    if last is None:
        return None
    # Свежая запись в журнале активного агента = работа идёт (оркестратор мог уснуть
    # в sleep между «запустил» и «проверил», но агент внутри пишет) — не простой
    adir = pf.get('ACTIVE_DIR', '') or os.path.dirname(pf.get('JOURNAL', ''))
    if adir and os.path.isdir(adir):
        for f in os.listdir(adir):
            if f.endswith('.jsonl') and time.time() - os.path.getmtime(os.path.join(adir, f)) < STALL_SOFT_SEC:
                return None
    age = time.time() - last
    if age > STALL_HARD_SEC:
        return (int(age // 60), 'hard')
    if age > STALL_SOFT_SEC:
        return (int(age // 60), 'soft')
    return None


# Значение в реестре → состояние узла на схеме. Правило общее для всех проектов.
_ST_MAP = {'done': 'done', 'approved': 'done', 'running': 'run', 'waiting': 'wait',
           'failed': 'stall', 'rejected': 'stall', 'blocked': 'skipbad'}


_dirty_cache = {}


def fe_dirty_count(task):
    """Сколько файлов изменено во фронтовом worktree задачи (кеш 30 с).
    Нужно, чтобы отличить честный пропуск браузерной проверки от сомнительного:
    «фронт не трогали» — штатно, «во фронте 285 файлов, но проверять не стали» — аномалия."""
    now = time.monotonic()
    c = _dirty_cache.get(task)
    if c and now - c[0] < 30:
        return c[1]
    wt = f'{FE}/worktree-t{task}'
    n = 0
    if os.path.isdir(wt):
        out = run(['git', '-C', wt, 'status', '--porcelain'], timeout=6)
        n = len([l for l in out.splitlines() if l.strip()])
    _dirty_cache[task] = (now, n)
    return n


def pipeline_statuses(task, sandbox_status, profile=None, route=None):
    """Статус каждого узла схемы: done|run|wait|pending|stall|skip|skipbad|premature.

    Движок НЕ знает этапов конкретного проекта: узлы, их порядок и связь с ключами реестра
    берутся из схемы профиля (profiles/<имя>/graph.json), а если её нет — из этапов маршрута.
    Раньше здесь был захардкожен конвейер arsenkin, и у другого проекта весь граф оставался
    серым, кроме случайно совпавших имён.
    """
    pf = parse_env_file(f'{STATE_DIR}/t{task}.pipeline')
    if not pf:
        return None
    profile = profile if profile is not None else pf.get('PROFILE', '')
    route = route if route is not None else pf.get('ROUTE', '')

    g = graph_of(route, profile)
    meta = profile_graph_meta(profile, route)
    keys, optional = meta['keys'], set(meta['optional'])
    chain = [n for n in g['pos'] if n != 'sandbox']   # порядок узлов = порядок этапов маршрута

    st = {'sandbox': {'run': 'done', 'up': 'run', 'stall': 'stall',
                      'down': 'stall'}.get(sandbox_status, 'pending')}
    unknown = set()   # этап, которого нет в реестре: движок его не вёл (старый прогон)
    for nid in chain:
        key = keys.get(nid, nid.upper())
        if key not in pf:
            unknown.add(nid)
            st[nid] = 'pending'
            continue
        raw = pf[key]
        if raw == 'skipped':
            # штатно пропускаемый этап — «—»; обязательный пропущенный — аномалия.
            # Браузерная проверка пропускается штатно ТОЛЬКО когда фронт не менялся:
            # в #7900 агент пропустил её при 285 изменённых файлах, и схема показывала
            # спокойное «—» — человек на воротах не увидел бы, что UI никто не смотрел.
            ok_to_skip = nid in optional
            if nid == 'browser' and ok_to_skip and task and fe_dirty_count(task) > 0:
                ok_to_skip = False
            st[nid] = 'skip' if ok_to_skip else 'skipbad'
        else:
            st[nid] = _ST_MAP.get(raw, 'pending')

    # Этапа нет в реестре, а работа ушла дальше по цепочке — значит прогон вёлся по прежней
    # схеме записи. Честный ответ здесь «нет данных», а не «пройдено»: рисовать галочку на
    # непроверенном этапе опаснее пустого места — по схеме принимают решение.
    touched = [i for i, n in enumerate(chain) if st[n] != 'pending']
    if touched:
        for n in chain[:touched[-1]]:
            if n in unknown:
                st[n] = 'idle'

    done_like = ('done', 'skip')

    # Ворота: реестр помечает их waiting, но пока движок туда не дошёл, ворота всё равно
    # «ждут тебя», если всё до них пройдено — показываем это, не дожидаясь записи в реестр.
    for i, nid in enumerate(chain):
        if not nid.startswith('gate_') or st[nid] != 'pending':
            continue
        if all(st[p] in done_like for p in chain[:i]):
            st[nid] = 'wait'

    # Гард ворот: ждать приёмку при недоделанном хвосте нельзя — это «преждевременно»,
    # а не «готово». Обязательные = все узлы маршрута до ворот, кроме штатно пропускаемых.
    for i, nid in enumerate(chain):
        if st.get(nid) == 'wait' and nid.startswith('gate_'):
            unfinished = [p for p in chain[:i]
                          if st[p] not in done_like and st[p] != 'idle' and p not in optional]
            if unfinished:
                st[nid] = 'premature'

    # Инвариант линейности: активен ровно один узел; более поздний = реальный фронт работы.
    active = [i for i, n in enumerate(chain) if st[n] in ('run', 'wait')]
    if len(active) > 1:
        keep = active[-1]
        for i, n in enumerate(chain):
            if st[n] in ('run', 'wait'):
                st[n] = 'done' if i < keep else 'pending'

    # Возврат после отклонённой приёмки: хвост от точки возврата снова pending.
    # Точка возврата — та же, что у движка при reject (сборка; если её нет — первый
    # рабочий узел после последних ворот).
    if pf.get('GATE_ACCEPT') == 'rejected' and pf.get('SHIP') not in ('done', 'running'):
        back = 'build' if 'build' in chain else next(
            (n for n in chain if not n.startswith('gate_')), None)
        if back:
            bi = chain.index(back)
            for n in chain[bi:]:
                st[n] = 'pending'
            recent = (pipeline_last_move(task, pf) or 0) > time.time() - 300
            st[back] = 'run' if recent else 'wait'
            st['_returned'] = True
    return st


# ---------- Конвейер фабрики: SVG-граф ----------

# ---- Узлы: описание (вид, подпись, сноска). Координаты — НЕ здесь: они у каждого маршрута свои.
NODE_DEFS = {}     # общий фолбэк (автосхемы); подписи проектов — в _PROFILE_NODES
_PROFILE_NODES = {}  # профиль → {узел: (вид, подпись, сноска)}


def node_def(nid, profile=None):
    """Подпись узла КОНКРЕТНОГО профиля. Раньше словарь был общий, и профиль,
    прочитанный последним, переименовывал одноимённые узлы на всех карточках."""
    return (_PROFILE_NODES.get(profile or '', {}).get(nid)
            or NODE_DEFS.get(nid)
            or ('agent', nid, ''))

# Иконка маршрута: тип работы читается взглядом, без вчитывания в слово.
# Неизвестный маршрут (свой у нового проекта) получает нейтральную точку, а не пустоту.
ROUTE_ICON = {
    'feature': '\u2728',    # новая функциональность
    'debug': '\U0001F50D',  # разбирательство: сначала понять, потом чинить
    'trivial': '\u26A1',    # мелкая правка
    'dev': '\U0001F6E0',    # обычный прогон проекта разработки
    'quick': '\u26A1',
}


def node_title(nid, profile=None):
    """Человеческая подпись узла без эмодзи (для строки прогресса).
    Берём подпись КОНКРЕТНОГО профиля: у разных проектов одноимённые узлы значат разное."""
    lbl = node_def(nid, profile)[1]
    return re.sub(r'^[^\w\u0400-\u04FF]+', '', lbl).strip() or nid


def progress_of(st, route, profile):
    """(пройдено, всего, подпись текущего этапа, класс состояния) по узлам маршрута."""
    chain = [n for n in graph_of(route, profile)['pos'] if n != 'sandbox']
    if not chain:
        return 0, 0, '', ''
    done = sum(1 for n in chain if st.get(n) in ('done', 'skip', 'idle'))
    cur = next((n for n in chain if st.get(n) in ('wait', 'premature')), None)
    kind = 'wait'
    if not cur:
        cur = next((n for n in chain if st.get(n) in ('run', 'stall', 'skipbad')), None)
        kind = 'run'
    if not cur:
        return done, len(chain), ('готово' if done >= len(chain) else ''), 'done'
    return done, len(chain), node_title(cur, profile), kind


def route_badge(route):
    """Бейдж маршрута с иконкой; для чужих маршрутов — нейтральный значок."""
    if not route:
        return ''
    icon = ROUTE_ICON.get(route, '\u25CF')
    return f'{icon} {html.escape(route)}'


MARKS = {'done': ' \u2713', 'run': ' \u25cf', 'wait': ' \u23f3', 'stall': ' \u26a0', 'pending': '',
         'skip': ' \u2014', 'idle': ' ?', 'skipbad': ' \u26a0', 'premature': ' \u26a0',
         'route': '', 'noroute': ''}
START_DOT = (30, 55)

# Схемы конвейеров живут в профилях (profiles/<имя>/graph.json), а не в движке:
# фабрика ведёт разные проекты, и «встроенный» граф одного из них — источник вранья
# на карточках всех остальных. Профиль без схемы получает автосхему из своих этапов.


FACTORY_HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROFILES_DIR = os.environ.get(
    'FACTORY_PROFILES_DIR',
    os.path.join(os.path.dirname(FACTORY_HOME), 'profiles'),
)
_PROFILE_GRAPHS = {}
_PROFILE_DEFAULT_ROUTE = {}
_PROFILE_META = {}      # профиль → {keys, optional}
_PROFILE_STAGES = {}    # профиль → {маршрут: [этапы]}


def profile_stages(profile):
    """Этапы маршрутов профиля (читаем сам профиль — он источник истины)."""
    if profile in _PROFILE_STAGES:
        return _PROFILE_STAGES[profile]
    out = {}
    path = os.path.join(PROFILES_DIR, profile, 'profile.sh')
    if profile and os.path.exists(path):
        txt = run(['bash', '-c',
                   f'source "{path}" 2>/dev/null\n'
                   'for v in $(compgen -A variable | grep "^PROFILE_ROUTE_STAGES_"); do\n'
                   '  n="$v[@]"; echo "${v#PROFILE_ROUTE_STAGES_} ${!n}"\ndone'], timeout=10)
        for line in txt.splitlines():
            parts = line.split()
            if len(parts) > 1:
                out[parts[0]] = parts[1:]
    _PROFILE_STAGES[profile] = out
    return out


def profile_graphs(profile):
    """Нарисованная схема конвейера проекта: profiles/<профиль>/graph.json."""
    if not profile:
        return {}
    if profile in _PROFILE_GRAPHS:
        return _PROFILE_GRAPHS[profile]
    path = os.path.join(PROFILES_DIR, profile, 'graph.json')
    data = {}
    try:
        with open(path, encoding='utf-8') as f:
            raw = json.load(f)
        for nid, dd in (raw.get('nodes') or {}).items():
            _PROFILE_NODES.setdefault(profile, {})[nid] = tuple(dd)
        _PROFILE_DEFAULT_ROUTE[profile] = raw.get('default_route')
        _PROFILE_META[profile] = {'keys': raw.get('keys') or {},
                                  'optional': raw.get('optional') or []}
        for rname, g in (raw.get('routes') or {}).items():
            data[rname] = {
                'vb': g['vb'],
                'pos': {k: tuple(v) for k, v in g['pos'].items()},
                'edges': [tuple(e) for e in g['edges']],
            }
    except FileNotFoundError:
        pass
    except Exception as e:                                   # noqa: BLE001
        print(f'[dashboard] схема профиля {profile} не прочитана: {e}')
    _PROFILE_GRAPHS[profile] = data
    return data


def profile_graph_meta(profile, route=None):
    """keys (узел → ключ реестра) и optional (штатно пропускаемые узлы) из схемы профиля.

    optional может зависеть от маршрута: пропуск тестов законен в debug (перформанс
    доказывается замером), но в feature это дефект. Формат — список либо
    {'*': [...], '<маршрут>': [...]}.
    """
    profile_graphs(profile)
    meta = _PROFILE_META.get(profile, {'keys': {}, 'optional': []})
    opt = meta.get('optional') or []
    if isinstance(opt, dict):
        opt = list(opt.get('*', [])) + list(opt.get(route or '', []))
    return {'keys': meta.get('keys', {}), 'optional': opt}


def autograph(profile, route):
    """Схема «по умолчанию» из этапов маршрута: змейка по рядам, ворота — человеческие узлы.

    Нужна, чтобы НОВЫЙ проект работал сразу после написания профиля: рисовать красивую
    схему можно потом, а видеть ход конвейера надо с первого прогона.
    """
    stages = profile_stages(profile).get(route or '') or []
    if not stages:
        return None
    PER_ROW, X0, DX, Y0, DY = 6, 170, 330, 55, 150
    pos, edges, prev = {}, [], None
    for i, stage in enumerate(stages):
        nid = stage.lower()
        row, col = divmod(i, PER_ROW)
        x = X0 + (col if row % 2 == 0 else PER_ROW - 1 - col) * DX   # змейка: ряды туда-обратно
        pos[nid] = (x, Y0 + row * DY)
        gate = nid.startswith('gate_')
        NODE_DEFS.setdefault(nid, ('human' if gate else 'agent',
                                   ('\U0001F464 ' if gate else '\U0001F916 ') + stage.lower(), ''))
        same_row = prev is not None and row == (i - 1) // PER_ROW
        edges.append((prev or '_start', nid, '', 'plain', 'h' if (prev is None or same_row) else 'v'))
        prev = nid
    rows = (len(stages) + PER_ROW - 1) // PER_ROW
    return {'vb': f'0 -34 {X0 + PER_ROW * DX} {Y0 + rows * DY + 60}', 'pos': pos, 'edges': edges}


def graph_of(route, profile=None):
    """Граф маршрута ПРОЕКТА: нарисованная схема профиля, иначе автосхема из его этапов.

    Движок не хранит ничьих графов: чужие узлы на схеме — это ложь про прогон.
    """
    pg = profile_graphs(profile)
    if route and route in pg:
        return pg[route]
    if not route and pg:
        # разведка ещё не выбрала маршрут — показываем основной путь профиля
        dflt = _PROFILE_DEFAULT_ROUTE.get(profile) or next(iter(pg))
        return pg.get(dflt) or next(iter(pg.values()))
    auto = autograph(profile, route or _PROFILE_DEFAULT_ROUTE.get(profile) or
                     next(iter(profile_stages(profile)), ''))
    if auto:
        return auto
    return {'vb': '0 -34 900 120', 'pos': {}, 'edges': []}


def node_geom(nid, pos, profile=None):
    """Геометрия узла: половина ширины считается от длины подписи (+запас под \u2713/\u25cf),
    чтобы текст всегда помещался."""
    kind, label, _ = node_def(nid, profile)
    cx, cy = pos[nid]
    if kind == 'code':
        return cx, cy, 70, 27
    hw = max(58, int((len(label) + 2) * 3.8) + 14)
    return cx, cy, hw, 17


def edge_path(src, dst, route, pos, profile=None):
    """Путь ребра от геометрии узлов — переживает любые изменения ширины подписей."""
    if src == '_start':
        sx, sy, shw, shh = START_DOT[0] + 4, START_DOT[1], 0, 0
    else:
        sx, sy, shw, shh = node_geom(src, pos, profile)
    dx, dy, dhw, dhh = node_geom(dst, pos, profile)
    if route == 'h':
        x1, x2 = (sx + shw, dx - dhw) if dx > sx else (sx - shw, dx + dhw)
        return f'M {x1} {sy} L {x2} {dy}', ((x1 + x2) // 2, sy - 10)
    if route == 'v':
        return f'M {sx} {sy + shh} L {dx} {dy - dhh}', (sx + 14, (sy + dy) // 2)
    if route == 'arc_up':
        x1, y1 = sx - int(shw * 0.5), sy - shh
        x2, y2 = dx + int(dhw * 0.5), dy - dhh
        c = sy - shh - 46
        return f'M {x1} {y1} C {x1 - 40} {c}, {x2 + 40} {c}, {x2} {y2}', ((x1 + x2) // 2, c + 8)
    if route == 'arc_up_hi':
        x1, y1 = sx, sy - shh
        x2, y2 = dx + int(dhw * 0.35), dy - dhh
        c = sy - shh - 72
        return f'M {x1} {y1} C {x1 - 100} {c}, {x2 + 120} {c}, {x2} {y2}', ((x1 + x2) // 2, c + 10)
    if route == 'arc_down':
        x1, y1 = sx + int(shw * 0.5), sy + shh
        x2, y2 = dx - int(dhw * 0.5), dy + dhh
        c = sy + shh + 42
        return f'M {x1} {y1} C {x1 + 40} {c}, {x2 - 40} {c}, {x2} {y2}', ((x1 + x2) // 2, c)
    if route == 'arc_down_hi':
        x1, y1 = sx + int(shw * 0.3), sy + shh
        x2, y2 = dx - int(dhw * 0.3), dy + dhh
        c = sy + shh + 78
        return f'M {x1} {y1} C {x1 + 120} {c}, {x2 - 120} {c}, {x2} {y2}', ((x1 + x2) // 2, c)
    if route == 'to_sandbox':
        return f'M {START_DOT[0] + 4} {START_DOT[1] + 6} C 150 {dy}, 500 {dy}, {dx - dhw} {dy}', (0, 0)
    if route == 'arc_down_x2':
        x1, y1 = sx + int(shw * 0.3), sy + shh
        x2, y2 = dx - int(dhw * 0.1), dy + dhh
        c = sy + shh + 104
        return f'M {x1} {y1} C {x1 + 200} {c}, {x2 - 260} {c}, {x2} {y2}', ((x1 + x2) // 2, c - 4)
    if route == 'arc_down_x3':
        x1, y1 = sx + int(shw * 0.3), sy + shh
        x2, y2 = dx, dy + dhh
        c = sy + shh + 128
        return f'M {x1} {y1} C {x1 + 300} {c}, {x2 - 320} {c}, {x2} {y2 + 4}', ((x1 + x2) // 2, c - 4)
    if route == 'arc_reject':
        x1, y1 = sx + shw, sy + 8
        x2, y2 = dx + int(dhw * 0.2), dy + dhh
        c = sy + 96
        return f'M {x1} {y1} C {x1 + 420} {c}, {x2 - 260} {c - 30}, {x2} {y2 + 4}', ((x1 + x2) // 2, c - 16)
    if route == 'from_sandbox':
        x1 = sx + shw
        x2, y2 = dx - int(dhw * 0.55), dy - dhh
        return f'M {x1} {sy} C {x1 + 260} {sy + 4}, {x2 - 120} {y2 - 38}, {x2} {y2}', ((x1 + x2) // 2, sy + 16)
    raise ValueError(route)


def graph_viewbox(g, profile=None):
    """Холст по фактическим узлам + поля. Зашитый в схему viewBox оставлял пустоту справа."""
    pos = g['pos']
    if not pos:
        return g['vb']
    xs, ys = [], []
    for nid in pos:
        # профиль обязателен: ширина узла считается от ЕГО подписи, без него правый узел обрезало
        cx, cy, hw, hh = node_geom(nid, pos, profile)
        xs += [cx - hw, cx + hw]
        ys += [cy - hh - 26, cy + hh + 26]   # запас под подписи рёбер и сноски узлов
    x0, x1 = min(xs + [START_DOT[0]]) - 24, max(xs) + 24
    y0, y1 = min(ys) - 10, max(ys) + 10
    return f'{int(x0)} {int(y0)} {int(x1 - x0)} {int(y1 - y0)}'


def loop_facts(task):
    """Возвраты и остановки из журнала этапов: что схема обязана показать человеку.

    Раньше стрелка возврата рисовалась одинаково всегда — и когда возврата не было,
    и когда конвейер по нему уже дважды сходил и встал. Человек видел красный узел,
    но не понимал ни что был откат, ни что работа остановлена и ждёт его.
    """
    f = {'loops': {}, 'halted': None, 'halt_msg': ''}
    if not task:
        return f
    path = f'{STATE_DIR}/logs/t{task}.stages.log'
    if not os.path.exists(path):
        return f
    try:
        for line in open(path, errors='ignore'):
            m = re.search(r'возврат в (\S+) из-за (\w+)', line)
            if m:
                key = m.group(2).lower()
                f['loops'][key] = f['loops'].get(key, 0) + 1
            m = re.search(r'(\w+): (\d+) возврата не помогли', line)
            if m:
                f['halted'] = m.group(1).lower()
                f['halt_msg'] = f"{m.group(2)} возврата не помогли"
            # после стопа человек мог перезапустить этап — старая остановка больше не факт
            if re.search(r'этап \w+ \(попытка', line) or 'маршрут:' in line:
                f['halted'] = None
    except OSError:
        pass
    return f


# Состояние узла схемы на человеческом языке. Вынесено из render_graph: те же расшифровки
# показывает окно этапа (/stage/...), а две копии словаря разъезжаются на первой же правке.
NODE_STATE_HINT = {
    'done': 'пройден', 'run': 'выполняется сейчас', 'wait': 'ждёт твоего решения',
    'pending': 'ещё не начинался', 'skip': 'пропущен осознанно',
    'idle': 'нет данных: этап не записан в реестре (прогон по прежней схеме)',
    'stall': 'завис — агент молчит', 'skipbad': 'пропущен без причины — аномалия',
    'premature': 'преждевременно: хвост маршрута не доделан',
}


def stage_doc_url(nid, task):
    """Документ этапа, если он у этапа есть: план / диагноз / отчёт приёмки.

    Раньше этот же маппинг был раскидан по onclick'ам узлов графа — из-за широких hit-box'ов
    приёмка открывалась при клике куда угодно (жалоба владельца «везде вылазит приёмка»).
    Теперь документ — не поведение узла, а поле окна этапа.
    """
    if nid == 'gate_plan':
        return f'/plan/t{task}', 'план работ'
    if nid == 'gate_cause':
        return f'/diag/t{task}', 'диагноз и план фикса'
    if nid == 'gate_accept':
        return f'/report/t{task}', 'отчёт приёмки'
    return None, ''


def render_graph(statuses, task=None, plan_exists=False, route=None, profile=None):
    """Рисует граф КОНКРЕТНОГО маршрута: чужие этапы в нём не существуют.

    plan_exists больше не влияет на клик (кликабельны все узлы) — параметр оставлен,
    чтобы не трогать вызовы; наличие документа проверяет уже окно этапа.
    """
    g = graph_of(route, profile)
    pos, vb = g['pos'], graph_viewbox(g, profile)
    p = [f'<svg class="graph" viewBox="{vb}" xmlns="http://www.w3.org/2000/svg">']
    p.append('<defs><marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">'
             '<path d="M0,0 L8,4 L0,8 z" fill="var(--edge)"/></marker></defs>')
    p.append(f'<circle class="startdot" cx="{START_DOT[0]}" cy="{START_DOT[1]}" r="4"/>')
    facts = loop_facts(task)
    for src, dst, lbl, cls, routing in g['edges']:
        d, (lx, ly) = edge_path(src, dst, routing, pos, profile)
        if cls == 'fail':
            # сколько раз конвейер реально ходил по этому возврату
            n = facts['loops'].get(src, 0)
            ecls = 'e-fail'
            if n:
                ecls += ' e-loop'                     # ярко: откат случился
                if statuses.get(dst) == 'run':
                    ecls += ' e-flow'                 # прямо сейчас переделывают
                lbl = f'{lbl} ×{n}' if lbl else f'возврат ×{n}'
        else:
            s = 'done' if src == '_start' else statuses.get(src, 'pending')
            ecls = {'done': 'e-on', 'skip': 'e-on', 'run': 'e-flow'}.get(s, 'e-off')
        p.append(f'<path class="edge {ecls}" d="{d}" marker-end="url(#arr)"/>')
        if lbl:
            p.append(f'<text class="elbl elbl-{cls}" x="{lx}" y="{ly}" text-anchor="middle">{html.escape(lbl)}</text>')
    for nid in pos:
        kind, label, sub = node_def(nid, profile)
        cx, cy = pos[nid]
        s = statuses.get(nid, 'pending')
        _, _, hw, hh = node_geom(nid, pos, profile)
        # ОДИН обработчик на ВСЕ узлы: окно этапа. Раньше клик вешался выборочно (план,
        # диагноз, отчёт, и только на run/stall — активность), а у done/pending/skip клика
        # не было вовсе. Мимо-клик проваливался в соседний, более широкий hit-box, и по
        # жалобе владельца «куда бы я ни кликнул — везде приёмка». Теперь у каждой фигуры
        # свой адрес: /stage/tNNN/<узел>, а документы/журнал — поля внутри окна.
        click = f' clickable" onclick="openStage(\'{task}\',\'{nid}\')' if task else ''
        hint = NODE_STATE_HINT.get(s, s)
        p.append(f'<g class="ng nk-{kind} ns-{s}{click}">')
        p.append(f'<title>{html.escape(label)} — {html.escape(hint)}</title>')
        if kind == 'code':
            p.append(f'<polygon points="{cx},{cy - 27} {cx + 70},{cy} {cx},{cy + 27} {cx - 70},{cy}"/>')
            sub_y = cy + 39
        else:
            rx = hh if kind == 'human' else 6
            p.append(f'<rect x="{cx - hw}" y="{cy - hh}" width="{hw * 2}" height="{hh * 2}" rx="{rx}"/>')
            sub_y = cy + 30
        p.append(f'<text x="{cx}" y="{cy + 4}" text-anchor="middle">{html.escape(label)}'
                 f'<tspan class="mk">{html.escape(MARKS[s])}</tspan></text>')
        if sub:
            down = any(s == nid and r in ('v', 'to_gate') for s, _dd, _l, _c, r in g['edges'])
            if down:   # линия уходит вниз из центра — подпись ставим сбоку, чтобы не перечёркивало
                p.append(f'<text class="mdl" x="{cx + 12}" y="{sub_y}" text-anchor="start">{html.escape(sub)}</text>')
            else:
                p.append(f'<text class="mdl" x="{cx}" y="{sub_y}" text-anchor="middle">{html.escape(sub)}</text>')
        p.append('</g>')
    p.append('</svg>')
    return ''.join(p)


# ---------- Таймер B24 ----------

# Трекер времени — проектный (arsenkin: b24-timer.mjs). Формат FACTORY_TIMER_CMD:
# 'node /path/b24-timer.mjs' — дашборд добавит <action> <task>. Пусто = без таймеров.
_TIMER = TIMER_CMD.split() if TIMER_CMD else []
_timer_cache = {}  # task -> (monotonic_ts, elapsed_s, running)


def task_timer_cmd(task):
    """Команда трекера ДЛЯ ЭТОЙ задачи. У проекта трекера может не быть — тогда пусто.
    Раньше трекер был один на фабрику, и про задачу #101 из rdesigner спрашивали B24 arsenkin,
    получая чужую задачу с тем же номером."""
    cmd = prof_env(task_profile(task))['TIMER']
    return cmd.split() if cmd else []


def b24_timer(action, task):
    cmd = task_timer_cmd(task)
    if not cmd:
        return None
    out = run([*cmd, action, str(task)], timeout=45 if action != 'get' else 8)
    try:
        return json.loads(out)
    except Exception:
        return None


def get_timer(task):
    """Состояние таймера с кэшем 25с; между опросами время дотикивается локально."""
    now = time.monotonic()
    c = _timer_cache.get(task)
    if c is None:
        return None  # наполнит фоновый поток — рендер сеть не трогает
    ts, el, running = c
    if el is None:
        return None
    live = el + int(now - ts) if running else el
    return {'elapsed': live, 'running': running}


ICON_CLOCK = ('<svg class="ic" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" '
              'stroke="currentColor" stroke-width="1.6"/><path d="M8 4.6V8l2.4 1.6" fill="none" '
              'stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>')
ICON_PLAY = '<svg class="ic" viewBox="0 0 16 16"><path d="M5 3.2v9.6L13 8z" fill="currentColor"/></svg>'
ICON_DOC = ('<svg class="ic" viewBox="0 0 16 16"><path d="M4 1.5h5.5L13 5v9.5H4z" fill="none" '
            'stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>'
            '<path d="M9.5 1.5V5H13M6 8h4M6 10.5h4" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>')
ICON_PAUSE = ('<svg class="ic" viewBox="0 0 16 16"><rect x="4" y="3.2" width="2.8" height="9.6" rx="1" '
              'fill="currentColor"/><rect x="9.2" y="3.2" width="2.8" height="9.6" rx="1" fill="currentColor"/></svg>')


_stats_cache = [0.0, None]  # [monotonic_ts, data]

# Названия задач: кэш ПЕРЕЖИВАЕТ рестарт дашборда (файл на диске).
# Заголовок задачи меняется раз в никогда, а трекер — внешняя сеть: дёргать его на каждый
# рендер (или заново после каждого рестарта) незачем. Время — wall-clock, чтобы TTL считался
# и через перезапуск. Протухшее значение НЕ выбрасываем: лучше показать вчерашнее название,
# чем пустоту, если трекер недоступен.
INFO_TTL = 6 * 3600
_info_file = f'{STATE_DIR}/cache/task-info.json'
_info_cache = {}  # task -> (unix_ts, data)


def _load_info_cache():
    try:
        with open(_info_file, encoding='utf-8') as f:
            for task, rec in json.load(f).items():
                _info_cache[task] = (rec['ts'], rec['data'])
    except Exception:
        pass


def _save_info_cache():
    try:
        os.makedirs(os.path.dirname(_info_file), exist_ok=True)
        tmp = _info_file + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump({t: {'ts': ts, 'data': data} for t, (ts, data) in _info_cache.items()},
                      f, ensure_ascii=False)
        os.replace(tmp, _info_file)   # атомарно: недописанный файл не переживёт падение
    except Exception:
        pass


def get_task_info(task):
    """Только кэш — сеть трогает фоновый поток (рендер не должен ждать трекер)."""
    return _info_cache.get(task, (0.0, None))[1]


def refresh_timer(task):
    d = b24_timer('get', task)
    now = time.monotonic()
    if not d or d.get('elapsed') is None:
        _timer_cache[task] = (now, None, False)
    else:
        _timer_cache[task] = (now, int(d['elapsed']), bool(d['running']))


def refresh_task_info(task):
    cmd = task_timer_cmd(task)
    if not cmd:
        # Проект без трекера: название лежит в реестре прогона — читаем ВСЕГДА, без TTL.
        # Номера прогонов переиспользуются, и кэш переживал смену задачи: карточка нового
        # прогона показывала заголовок предыдущего (#102 «окна» подписан как «встать в комнату»).
        tk = parse_env_file(f'{STATE_DIR}/t{task}.pipeline').get('TICKET', '').strip()
        if tk and (_info_cache.get(task, (0.0, {}))[1] or {}).get('title') != tk:
            _info_cache[task] = (time.time(), {'title': tk, 'description': ''})
            _save_info_cache()
        return
    ts, data = _info_cache.get(task, (0.0, None))
    if data is not None and time.time() - ts < INFO_TTL:
        return
    out = run([*cmd, 'info', str(task)], timeout=45)
    try:
        info = json.loads(out)
    except Exception:
        return          # трекер молчит — старое значение остаётся в кэше
    if info.get('title'):
        _info_cache[task] = (time.time(), info)
        _save_info_cache()


def b24_refresher():
    """Фоновый поток: статы шапки + карточки живых задач, каждые 30с."""
    import threading  # noqa: F401 — поток стартует в __main__

    while True:
        try:
            refresh_b24_stats()
        except Exception:
            pass                      # статистика в шапке — не повод оставить карточки без названий
        try:
            tasks = [m.group(1) for f in (os.listdir(STATE_DIR) if os.path.isdir(STATE_DIR) else [])
                     if (m := re.match(r'^t(\d+)\.pipeline$', f))]
        except Exception:
            tasks = []
        for t in tasks:
            for fn in (refresh_task_info, refresh_timer):
                try:
                    fn(t)
                except Exception:
                    pass              # одна недоступная задача не должна ронять обход остальных
        time.sleep(30)


def get_b24_stats():
    """Только кэш — сеть B24 трогает фоновый поток (рендер не должен блокироваться)."""
    return _stats_cache[1]


_stats_file = f'{STATE_DIR}/cache/b24-stats.json'


def refresh_b24_stats():
    if not _TIMER:
        return
    out = run([*_TIMER, 'stats'], timeout=45)
    try:
        data = json.loads(out)
    except Exception:
        return                       # трекер молчит — показываем прошлые данные, а не пустоту
    _stats_cache[:] = [time.monotonic(), data]
    try:
        os.makedirs(os.path.dirname(_stats_file), exist_ok=True)
        tmp = _stats_file + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, _stats_file)
    except Exception:
        pass


def _load_stats_cache():
    """Шапка не должна быть пустой первые 30с после рестарта — берём прошлый снимок."""
    try:
        with open(_stats_file, encoding='utf-8') as f:
            _stats_cache[:] = [time.monotonic(), json.load(f)]
    except Exception:
        pass


def fmt_hms(s):
    return f'{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}'


# ---------- HTML ----------

BADGES = {
    'run':   ('&#9679;', 'работает', 'st-good'),
    'up':    ('&#8987;', 'поднимается', 'st-info'),
    'stall': ('&#9888;', 'застряла', 'st-serious'),
    'down':  ('&#9632;', 'остановлена', 'st-critical'),
}

CSS = """
/* Палитра: нейтральный графит вместо «зелёного терминала» — цвет несут статусы, а не фон.
   Смысл цвета: зелёный = сделано, синий = идёт, оранжевый = ждёт человека, красный = сломано. */
:root {
  /* Дизайн-шкала: радиусы, ритм, движение. До неё в стилях было 8 разных радиусов
     и 9 вариантов отступов — интерфейс выглядел собранным из кусков. */
  --r-sm:6px; --r-md:10px; --r-lg:14px; --r-pill:999px;
  --sp-1:4px; --sp-2:8px; --sp-3:12px; --sp-4:16px; --sp-5:20px;
  --ease:160ms cubic-bezier(.2,.6,.3,1);
  --topH:54px; --surface:#0b0d11; --card:#151920; --card2:#1b2029; --cardline:#252b35;
  --ink:#e7eaf0; --ink2:#8a93a3;
  --good:#3fb950; --info:#5aa2ff; --serious:#e0a33a; --critical:#f0564c;
  --edge:#39424f; --edge-on:#3fb950; --agent:#e0873f; --human:#d9c04a; --codenode:#37b7c3;
  --shadow:inset 0 1px 0 #ffffff0a, 0 1px 2px #00000050, 0 6px 22px #00000055; }
:root[data-theme="light"] { --surface:#f5f6f8; --card:#ffffff; --card2:#f8f9fb; --cardline:#e2e5ea;
  --ink:#161a20; --ink2:#586173;
  --good:#1a7f37; --info:#0a66d0; --serious:#9a6700; --critical:#cf222e;
  --edge:#c2c8d0; --edge-on:#1a7f37; --agent:#bd6a1f; --human:#8a6d09; --codenode:#0f7f8c;
  --shadow:inset 0 1px 0 #ffffff, 0 1px 2px #0000000f, 0 6px 18px #00000012; }
[data-theme="light"] .graph .ng rect, [data-theme="light"] .graph .ng polygon { fill:#ffffff; }
/* На белом фоне непройденные узлы почти растворялись — держим минимальный контраст рамки */
[data-theme="light"] .graph .ns-pending rect, [data-theme="light"] .graph .ns-pending polygon
  { stroke:#c3c9d2; }
[data-theme="light"] .graph .ns-pending text { fill:#7c8493; }
[data-theme="light"] .graph .ns-run rect, [data-theme="light"] .graph .ns-run polygon { fill:#eaf2fd; }
[data-theme="light"] .graph .ns-wait rect, [data-theme="light"] .graph .ns-wait polygon { fill:#fdf4e6; }
[data-theme="light"] .graph .e-fail { stroke:#dcb0ac; }
[data-theme="light"] .doc code { background:#f0f2f5; color:#0a66d0; border-color:#e2e5ea; }
* { box-sizing:border-box; margin:0; }
/* Интерфейсный шрифт — системный гротеск; моноширинный оставлен ТОЛЬКО техническим данным
   (номера задач, порты, ветки, таймеры), где важно выравнивание знаков. */
body { background:var(--surface); color:var(--ink);
  font:14px/1.55 system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;
  padding:0 0 40px; -webkit-font-smoothing:antialiased; }
code, .mono, .tmr, .pnum, .strip .br, .clock { font-family:ui-monospace,'SF Mono','Cascadia Mono',Consolas,monospace; }
#app { max-width:1760px; margin:0 auto; padding:0 26px; }
/* Шапка прилипает: при шести задачах фильтр и часы нужны на любом месте прокрутки */
.top { display:flex; align-items:center; gap:var(--sp-4); padding:12px 0; position:sticky; top:0;
  z-index:6; background:color-mix(in srgb, var(--surface) 88%, transparent);
  backdrop-filter:blur(10px); border-bottom:1px solid var(--cardline); }
h1 { font-size:16px; letter-spacing:.04em; font-weight:650; display:flex; align-items:center; gap:var(--sp-2); }
h1 .live { color:var(--good); font-size:11px; letter-spacing:.1em; font-weight:600;
  border:1px solid color-mix(in srgb, var(--good) 40%, transparent); border-radius:var(--r-pill);
  padding:2px 9px; background:color-mix(in srgb, var(--good) 12%, transparent); }
.top a { font-size:13px; color:var(--ink2); padding:5px 10px; border-radius:var(--r-md); }
.top a:hover { color:var(--ink); background:var(--card); text-decoration:none; }
.thm { background:none; border:1px solid var(--cardline); color:var(--ink2);
  border-radius:var(--r-md); width:30px; height:28px; cursor:pointer; font-size:14px; transition:.15s; }
.thm:hover { color:var(--ink); border-color:var(--ink2); }
.wd { background:none; border:1px solid var(--cardline); color:var(--ink2); border-radius:var(--r-md);
  padding:4px 10px; font-size:12px; cursor:pointer; font-family:inherit; transition:.15s; }
.wd:hover { color:var(--ink); border-color:var(--ink2); }
.wd.on { color:var(--edge-on); border-color:var(--edge-on); }
.clock { font-size:19px; color:var(--ink); font-variant-numeric:tabular-nums; letter-spacing:.02em; }
h2 { font-size:11px; color:var(--ink2); font-weight:600; text-transform:uppercase;
  letter-spacing:.14em; margin:22px 0 12px; display:flex; align-items:center; gap:var(--sp-2); }
h2 .cnt { color:var(--ink2); background:var(--card2); border:1px solid var(--cardline);
  border-radius:var(--r-pill); padding:2px var(--sp-2); font-size:11px; letter-spacing:0; }
.sub { color:var(--ink2); font-size:12px; padding:10px 0 0; }
.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(350px,1fr)); gap:var(--sp-3); }
.card { background:var(--card); border:1px solid var(--cardline); border-radius:var(--r-lg);
  padding:var(--sp-4) var(--sp-5); box-shadow:var(--shadow); }
.card.wide { border-left:3px solid var(--cardline); margin-bottom:22px; }
.card.wide.attn { border-left-color:var(--serious); }
.card.wide.act { border-left-color:var(--info); }
[data-theme="light"] .card { background:#ffffff; border-color:var(--cardline); box-shadow:0 1px 6px #0000000f; }
.wide { margin-bottom:12px; }
.hdr { display:flex; align-items:flex-start; gap:var(--sp-4); margin-bottom:10px; }
.hdr:last-child { margin-bottom:0; }
.hdr .hmain { min-width:0; }                       /* без этого длинный заголовок ломает flex */
.hdr .tline { display:flex; align-items:center; gap:var(--sp-2); }
.hdr .ttl { color:var(--ink); font-size:15px; font-weight:600; letter-spacing:.01em;
  max-width:74vw; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* служебное — мелко и приглушённо: номер, проект, маршрут, расход токенов */
.hdr .meta { margin-top:4px; font-size:11.5px; color:var(--ink2); letter-spacing:.04em;
  text-transform:uppercase; }
.hdr .badge { line-height:1; }
.hdr .tinfo { cursor:pointer; color:var(--ink2); display:inline-flex; padding:2px; }
.hdr .tinfo:hover { color:var(--info); }
.hdr .tctl { margin-left:auto; display:inline-flex; align-items:center; gap:10px; }
.hdr .badge.st-info { font-size:10px; border:1px solid #58a6ff44; border-radius:var(--r-md);
  padding:2px var(--sp-2); background:#58a6ff12; }
.badge { font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
.st-good{color:var(--good); text-shadow:0 0 8px #39d35355}
.st-info{color:var(--info); text-shadow:0 0 8px #58a6ff55}
.st-serious{color:var(--serious); text-shadow:0 0 8px #f0a13c55}
.st-critical{color:var(--critical); text-shadow:0 0 8px #f0554d55}
.kv { display:grid; grid-template-columns:auto 1fr; gap:2px 14px; font-size:12.5px; }
.kv span:nth-child(odd) { color:var(--ink2); }
a { color:var(--info); text-decoration:none; } a:hover { text-decoration:underline; }
.meter { height:5px; background:#1c2b22; border-radius:var(--r-sm); overflow:hidden; margin:8px 0 4px; }
.meter i { display:block; height:100%; background:linear-gradient(90deg,var(--edge-on),#7ee2a8); border-radius:var(--r-sm);
  box-shadow:0 0 8px #39d35388; }
.stages { font-size:11.5px; color:var(--ink2); margin-top:6px; }
table { border-collapse:collapse; margin-top:6px; font-size:12.5px; }
td { padding:1px 12px 1px 0; } td:last-child { text-align:right; font-variant-numeric:tabular-nums; color:var(--serious); }
.empty { color:var(--ink2); font-size:13px; padding:8px 0; }
.orph { color:var(--serious); font-size:12.5px; }
.needme { font-size:12px; color:var(--serious); font-weight:600; letter-spacing:0;
  text-transform:none; margin-left:8px; }
/* Карточка, которая ждёт решения человека: заметная слева полоса, а не только цвет рамки */
.card[data-wait] { border-left:3px solid var(--serious); }
/* Схема читается хуже всего из-за равного веса всего: приглушаем пройденное и петли отказов,
   оставляя внимание на текущем узле и ближайших воротах. */
.graph .ns-done { opacity:.55; }
.graph .e-on { opacity:.4; }
.graph .e-fail { opacity:.28; }
/* возврат СЛУЧИЛСЯ: стрелка яркая, с подписью сколько раз; активный — бежит */
.graph .e-loop { opacity:1; stroke-width:2.2; }
.graph .e-loop.e-flow { stroke-dasharray:7 5; animation:flow 1.1s linear infinite; }
.graph .elbl-fail { font-weight:600; opacity:.5; }
.graph .ns-run rect, .graph .ns-run polygon { stroke-width:2.5; }
.graph .ns-wait rect, .graph .ns-wait polygon { stroke-width:2.5; }
/* Полоса прогресса: сколько этапов маршрута пройдено и где сейчас работа */
.prg { display:flex; align-items:center; gap:var(--sp-2); margin-top:7px; }
.pbar { width:150px; height:5px; border-radius:var(--r-sm); background:var(--cardline); overflow:hidden;
  display:inline-block; }
.pbar i { display:block; height:100%; background:var(--good); border-radius:var(--r-sm); transition:width .4s; }
/* цвет прогресса говорит о состоянии: идёт работа / ждёт человека / всё пройдено */
.pk-run .pbar i { background:var(--info); }
.pk-wait .pbar i { background:var(--serious); }
.livedot { display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--info);
  margin-right:6px; vertical-align:1px; animation:pulse 1.6s infinite; }
.pnum { font-size:11px; color:var(--ink2); font-variant-numeric:tabular-nums; }
.pw { font-size:12px; }
.pw-run { color:var(--info); } .pw-wait { color:var(--serious); } .pw-done { color:var(--good); }
/* Компактный вид: схема и подвал скрыты, видна только суть — заголовок, прогресс, действия */
:root[data-view="compact"] .gwrap, :root[data-view="compact"] .strip { display:none; }
:root[data-view="compact"] .card { padding-bottom:12px; }
:root[data-view="compact"] .card.open .gwrap { display:block; }
/* именно flex: display:block ломал отступы между элементами подвала — текст слипался */
:root[data-view="compact"] .card.open .strip { display:flex; }
.vsw + .vsw { margin-left:0; }
:root[data-loops="on"] .lo { color:var(--info); }
.vsw { margin-left:auto; cursor:pointer; font-size:12px; color:var(--ink2); user-select:none;
  border:1px solid var(--cardline); border-radius:var(--r-lg); padding:var(--sp-1) var(--sp-3); }
.vsw:hover { border-color:var(--info); color:var(--info); }
:root[data-view="compact"] .vd, :root:not([data-view="compact"]) .vc { display:none; }
.hdr .hmain { cursor:pointer; }
/* Фильтр прилипает под шапкой: при шести задачах и длинных схемах он уезжает вверх ровно
   тогда, когда нужен — переключиться между проектами по ходу просмотра. */
.filterbar { display:flex; align-items:center; gap:var(--sp-2); padding:12px 0; position:sticky;
  top:var(--topH); z-index:4; background:color-mix(in srgb, var(--surface) 92%, transparent);
  backdrop-filter:blur(10px); border-bottom:1px solid var(--cardline); }
.filterbar .flabel { font-size:11px; letter-spacing:.12em; text-transform:uppercase;
  color:var(--ink2); margin-right:2px; }
.pfil { cursor:pointer; border:1px solid var(--cardline); border-radius:var(--r-pill); padding:var(--sp-1) var(--sp-3);
  font-size:12.5px; color:var(--ink2); user-select:none; }
.pfil:hover { border-color:var(--info); color:var(--info); }
.pfil b { font-weight:700; opacity:.75; }
.pfil .wt { font-style:normal; font-size:11px; font-weight:700; margin-left:7px; padding:2px var(--sp-2);
  border-radius:var(--r-pill); color:#1a1205; background:var(--serious); }
.pfil.has-wait { border-color:color-mix(in srgb, var(--serious) 55%, transparent); }
.pfil.has-wait::before { content:''; display:inline-block; width:6px; height:6px; border-radius:50%;
  background:var(--serious); margin-right:7px; vertical-align:1px; animation:pulse 2s infinite; }
:root[data-project] .pfil { opacity:.55; }
:root[data-project] .pfil.on { opacity:1; border-color:var(--info); color:var(--info);
  background:#58a6ff14; }
/* Скрытие чужих карточек — на CSS, чтобы фильтр переживал перерисовку без участия JS.
   Правила генерятся ПО ПРОФИЛЮ: общее правило «скрыть всё» оказывалось специфичнее правила
   «показать своё», и при выборе проекта исчезали ВСЕ карточки. */
PROJECT_RULES
.strip .dim { color:var(--ink2); }
.strip .br { font-family:ui-monospace,monospace; }
.strip .badge { text-transform:none; letter-spacing:.02em; font-weight:600; }
.strip { display:flex; flex-wrap:wrap; align-items:center; gap:6px 22px; margin-top:12px; padding-top:12px;
  border-top:1px solid var(--cardline); font-size:12.5px; align-items:baseline; }
.strip .k { color:var(--ink2); margin-right:7px; }
/* Снос стенда — действие разрушительное и редкое: кнопка приглушена, ярче только под курсором */
.sbdown { font:12px ui-monospace,monospace; color:var(--ink2); background:none; cursor:pointer;
  border:1px solid var(--cardline); border-radius:var(--r-sm); padding:1px 9px; }
.sbdown:hover { color:var(--critical); border-color:color-mix(in srgb,var(--critical) 55%,transparent); }
.sbdown:disabled { opacity:.55; cursor:default; }
/* --- SVG-граф конвейера --- */
.graph { width:100%; display:block; margin-top:10px; }
.graph .startdot { fill:var(--good); filter:drop-shadow(0 0 4px var(--good)); }
.graph .edge { fill:none; stroke-width:1.4; }
.graph .e-off { stroke:var(--edge); opacity:.30; }
.graph .e-on { stroke:var(--edge-on); opacity:.7; }
.graph .e-flow { stroke:var(--edge-on); opacity:.9; stroke-dasharray:7 6; animation:flow 1s linear infinite;
  filter:drop-shadow(0 0 4px #39d35388); }
.graph .e-fail { stroke:#7c4038; opacity:.5; }
.graph .elbl { font:10.5px ui-monospace,monospace; fill:var(--ink2); }
.graph .elbl-pass { fill:var(--good); } .graph .elbl-fail { fill:var(--critical); }
.graph .ng rect, .graph .ng polygon { fill:#0e1611; stroke-width:1.6; }
.graph .ng text { font:12px ui-monospace,monospace; fill:var(--ink); }
.graph .nk-agent rect { stroke:var(--agent); }
.graph .nk-human rect { stroke:var(--human); }
.graph .nk-code polygon { stroke:var(--codenode); }
.graph .ns-pending { opacity:.30; }
.graph .ns-skip { opacity:.45; }
.graph .ns-idle { opacity:.7; }
.graph .ns-idle rect, .graph .ns-idle polygon { stroke:var(--info); stroke-dasharray:6 4; }
.graph .ns-idle .mk { fill:var(--ink2); }
.graph .ns-skipbad rect, .graph .ns-skipbad polygon { stroke:var(--critical); stroke-dasharray:5 4; }
.graph .ns-skipbad .mk { fill:var(--critical); }
.graph .ns-skipbad { filter:drop-shadow(0 0 6px var(--critical)); }
.graph .ns-premature rect, .graph .ns-premature polygon { stroke:var(--critical); stroke-width:2.2; }
.graph .ns-premature .mk { fill:var(--critical); }
.graph .ns-premature { filter:drop-shadow(0 0 9px var(--critical)); animation:pulse 1.6s ease-in-out infinite; }
.graph .ns-skip rect, .graph .ns-skip polygon { stroke-dasharray:4 4; }
.graph .ns-done .mk { fill:var(--good); }
.graph .ns-run .mk { fill:var(--info); }
.graph .ns-wait .mk { fill:var(--serious); }
.graph .ns-stall .mk { fill:var(--critical); }
.graph .ns-run { animation:pulse 1.6s ease-in-out infinite; filter:drop-shadow(0 0 9px var(--info)); }
.graph .ns-run rect, .graph .ns-run polygon { stroke:var(--info); stroke-width:2.2; fill:#0e1a2b; }
.graph .ns-wait { filter:drop-shadow(0 0 9px var(--serious)); animation:pulse 2.2s ease-in-out infinite; }
.graph .ns-wait rect, .graph .ns-wait polygon { stroke:var(--serious); stroke-width:2.2; fill:#20160a; }
.graph .ns-stall rect, .graph .ns-stall polygon { stroke:var(--critical); stroke-width:2.2; }
.graph .ns-stall { filter:drop-shadow(0 0 8px var(--critical)); }
@keyframes pulse { 50% { opacity:.55; } }
@keyframes flow { to { stroke-dashoffset:-13; } }
.tmr { font-size:16px; color:var(--ink2); font-variant-numeric:tabular-nums;
  display:inline-flex; align-items:center; gap:var(--sp-2); line-height:1; }
.tmr .ic { vertical-align:0; }
.tmr .tval { font-weight:600; }
.tmr.on { color:var(--good); text-shadow:0 0 8px #39d35355; }
.ic { width:15px; height:15px; display:inline-block; vertical-align:-2px; }
.runbtn { background:#39d3531a; border:1px solid var(--good); color:var(--good); border-radius:var(--r-md);
  cursor:pointer; padding:3px 12px; font:12px ui-monospace,monospace;
  /* на узком экране кнопка переносила слово и вырастала в два этажа */
  white-space:nowrap; flex-shrink:0; }
.pfil, .runbtn, .tbtn, .wd, .thm, .top a, .card { transition: background var(--ease), border-color var(--ease),
  box-shadow var(--ease), transform var(--ease), color var(--ease); }
.card:hover { border-color:color-mix(in srgb, var(--cardline) 55%, var(--ink2)); }
.pfil:hover, .wd:hover, .thm:hover { transform:translateY(-1px); }
.runbtn:active, .pfil:active, .wd:active { transform:translateY(0); }
:where(a, button, .pfil, .vsw, .wd, .thm, [onclick]):focus-visible {
  outline:2px solid var(--info); outline-offset:2px; border-radius:var(--r-sm); }
/* Пропустить к списку задач — первым по Tab, видно только при фокусе */
.skip { position:absolute; left:-9999px; top:8px; background:var(--card); color:var(--ink);
  border:1px solid var(--info); border-radius:var(--r-md); padding:var(--sp-2) var(--sp-3); z-index:20; }
.skip:focus { left:26px; }
@keyframes cardIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
.card.wide { animation:cardIn 260ms cubic-bezier(.2,.6,.3,1) both; }
/* Планшет и узкое окно: шапка разваливалась — логотип уезжал под иконку, ссылки ломались
   в две строки. Сжимаем: подписи навигации прячем, оставляя иконки, часы делаем компактнее. */
@media (max-width: 900px) {
  #app { padding:0 14px; }
  h1 { font-size:14px; white-space:nowrap; }
  h1 .live { font-size:10px; padding:1px 7px; }
  .top { gap:var(--sp-2); padding:8px 0; }
  .top a { padding:5px 7px; font-size:0; }              /* остаётся только иконка */
  .top a .ic, .top a img { font-size:13px; }
  .wd { font-size:0; padding:5px 8px; }
  .wd::first-letter { font-size:13px; }                  /* эмодзи-индикатор виден */
  .clock { font-size:15px; margin-left:auto; }
  .filterbar { flex-wrap:wrap; }
  .hdr .ttl { max-width:100%; }
}
/* страница открыта во фрейме модалки — своя навигация там лишняя */
.in-frame .back, .in-frame .top a[href="/"] { display:none; }
@media (prefers-reduced-motion: reduce) { * { transition:none !important; animation:none !important; } }
.runbtn.gate { background:color-mix(in srgb, var(--serious) 12%, transparent);
  border-color:var(--serious); color:var(--serious); }
.runbtn.gate:hover { box-shadow:0 0 10px color-mix(in srgb, var(--serious) 35%, transparent); }
.runbtn:hover { box-shadow:0 0 10px #39d35344; } .runbtn:disabled { opacity:.6; cursor:default; }
.tbtn { background:none; border:1px solid var(--cardline); color:var(--ink2); border-radius:var(--r-md);
  cursor:pointer; width:30px; height:24px; display:inline-flex; align-items:center; justify-content:center; }
.tbtn .ic { width:12px; height:12px; }
.tbtn:hover { border-color:var(--good); color:var(--good); box-shadow:0 0 8px #39d35333; }
.tbtn.on { color:var(--serious); }
.tbtn.on:hover { border-color:var(--serious); color:var(--serious); box-shadow:0 0 8px #f0a13c33; }
.graph text { font-family:ui-monospace,'SF Mono',Consolas,monospace; }
.graph .mdl, .graph .elbl { paint-order: stroke fill; stroke: var(--card); stroke-width: 3.5px;
  stroke-linejoin: round; }
.graph .mdl { font:9.5px ui-monospace,monospace; fill:var(--ink2); opacity:.85; }
/* Петли возврата (ревью → сборка и т.п.) — шум на каждой схеме: их десяток, и они пересекают
   весь граф. Прячем за переключатель: маршрут читается по прямой линии, а «что будет при
   провале» — по требованию. */
:root:not([data-loops="on"]) .graph .e-fail,
:root:not([data-loops="on"]) .graph .elbl-fail { display:none; }
.graph .clickable { cursor:pointer; }
.graph .clickable:hover rect, .graph .clickable:hover polygon { stroke-width:3; }
#modal { display:none; position:fixed; inset:0; background:#000000bb; z-index:10; }
#modal.open { display:flex; }
/* высота по содержимому: при коротком логе модалка не растягивается на весь экран */
.mbox { margin:auto; width:min(1120px,94vw); height:auto; max-height:90vh; min-height:220px;
  background:var(--surface);
  border:1px solid var(--cardline); border-radius:var(--r-md); overflow:hidden; position:relative;
  box-shadow:0 0 60px #000; }
.mclose { position:absolute; top:10px; right:16px; color:var(--ink2); font-size:20px;
  cursor:pointer; z-index:11; } .mclose:hover { color:var(--ink); }
#planframe { width:100%; height:88vh; border:0; background:var(--surface); }
"""


def project_css():
    """Пара правил на профиль: показать свои карточки и подсветить активный чип."""
    names = sorted(
        name for name in os.listdir(PROFILES_DIR)
        if os.path.isfile(os.path.join(PROFILES_DIR, name, 'profile.sh'))
    )
    out = []
    for n in names:
        out.append(f':root[data-project="{n}"] .card[data-profile]:not([data-profile="{n}"])'
                   f' {{ display:none; }}')
        out.append(f':root[data-project="{n}"] .pfil[data-p="{n}"] {{ opacity:1; '
                   f'border-color:var(--info); color:var(--info); background:#58a6ff14; }}')
    out.append(':root[data-project="all"] .pfil[data-p="all"] { opacity:1; '
               'border-color:var(--info); color:var(--info); background:#58a6ff14; }')
    return '\n'.join(out)


def render():
    boxes = collect_sandboxes()
    slots = collect_slots()
    orphans = collect_orphan_schemas({b['task'] for b in boxes})
    main_br, _ = git_info(f'{BE}/html')

    p = []
    p.append('<!doctype html><html lang="ru"><head><meta charset="utf-8">')
    p.append('<meta name="viewport" content="width=device-width,initial-scale=1">')
    p.append('<script>document.documentElement.dataset.theme = localStorage.getItem("factory-theme") || "dark";</script>')
    p.append('<title>Фабрика</title><style>'
                 + CSS.replace('PROJECT_RULES', project_css())
                 + '</style></head><body>'
                 + '<a class="skip" href="#tasks">К списку задач</a>'
                 + '<div id="app">')
    p.append('<div class="top" data-key="top"><h1>&#127981; ФАБРИКА <span class="live">&#9679; LIVE</span></h1>')
    if not _TIMER:
        # Молчаливая поломка стоила дорого: названия задач просто не появлялись, и было неясно,
        # трекер ли недоступен или дашборд их не запрашивает. Теперь это видно на странице.
        p.append('<span class="badge st-warn" style="margin-left:18px" '
                 'title="у дашборда нет команды трекера по умолчанию (FACTORY_TIMER_CMD в env профиля, '
                 'значение с пробелом — в кавычках): сводка в шапке недоступна. '
                 'Задачи проектов со своим трекером это не затрагивает">'
                 '&#9888; сводка трекера недоступна</span>')
    p.append('<a href="/routes" target="_blank" style="margin-left:auto;font-size:12px">&#128506; маршруты</a>')
    p.append('<a href="/tasks" target="_blank" style="margin-left:14px;font-size:12px">&#128220; задачи</a>')
    p.append('<a href="/stats" style="margin-left:14px;font-size:12px">&#128202; статистика</a>')
    p.append('<button class="thm" onclick="toggleTheme()" title="тема" style="margin-left:14px">&#9681;</button>')
    p.append(f'<span class="clock">{time.strftime("%H:%M:%S")}</span></div>')
    b24 = get_b24_stats()
    b24_line = ''
    if b24:
        h = b24.get('today_hours') or 0
        b24_line = (f' · B24: &#9654; <span class="st-good">таймер на {b24.get("running", 0)}</span>'
                    f' · в работе {b24["in_work"]} из {b24["total"]}'
                    f' · сегодня отработано <span class="st-good">{int(h)}ч {int(h % 1 * 60):02d}м</span>')
    projects = sorted({b['profile'] for b in boxes if b['profile']})
    # Фильтр по проекту: задачи разных проектов идут вперемешку, и на 5-6 карточках это каша.
    # Выбор держим в localStorage и применяем ЧЕРЕЗ CSS — иначе он слетал бы при каждом
    # обновлении страницы (карточки перерисовываются раз в 5 с).
    # Статусы считаем ЗДЕСЬ: они нужны и чипам фильтра (индикатор «ждёт решения»),
    # и списку задач ниже. Раньше считались только для списка, и чип не мог знать про ворота.
    st_by_task = {b['task']: (pipeline_statuses(b['task'], b['status'], profile=b['profile']) or {})
                  for b in boxes}

    def _waiting(b):
        return any(v in ('wait', 'premature') for v in st_by_task.get(b['task'], {}).values())

    wait_all = sum(1 for b in boxes if _waiting(b))
    chips = [f'<span class="pfil" data-p="all" onclick="setProject(\'all\')">'
             f'все <b>{len(boxes)}</b>'
             + (f'<i class="wt" title="ждут твоего решения">{wait_all}</i>' if wait_all else '')
             + '</span>']
    for x in projects:
        cnt = sum(1 for b in boxes if b['profile'] == x)
        wt = sum(1 for b in boxes if b['profile'] == x and _waiting(b))
        chips.append(f'<span class="pfil{" has-wait" if wt else ""}" data-p="{html.escape(x)}" '
                     f'onclick="setProject(\'{html.escape(x)}\')">&#128230; {html.escape(x)} '
                     f'<b>{cnt}</b>'
                     + (f'<i class="wt" title="ждут твоего решения">{wt}</i>' if wt else '')
                     + '</span>')
    pr_line = ''
    if projects:
        p.append('<div class="filterbar" data-key="filterbar"><span class="flabel">проект</span>'
                 + ''.join(chips)
                 + '<span class="vsw" onclick="toggleLoops()" title="петли возврата: что будет, '
                   'если этап провалится (ревью → сборка и т.п.)">'
                   '<span class="lo">&#8635; петли</span></span>'
                 + '<span class="vsw" onclick="toggleView()" title="компактно: только строка '
                   'с прогрессом; подробно: со схемой конвейера">'
                   '<span class="vc">&#9776; компактно</span>'
                   '<span class="vd">&#9638; подробно</span></span>'
                 + '</div>')
    p.append(f'<div class="sub" data-key="sub">авто-обновление 5 с{pr_line} · arsenkin/master: '
             f'{html.escape(main_br or "?")}{b24_line}</div>')

    # --- Задачи: граф конвейера + инфо песочницы в ОДНОЙ карточке ---
    def sandbox_strip(b):
        """Подвал карточки: ОДИН статус стенда, ветка, предупреждения.

        Раньше здесь стояли три способа сказать одно и то же — «песочница работает»,
        «контейнеры app=running, fe=running» и «horizon ✓». Детали никуда не делись:
        они в подсказке при наведении на статус.
        """
        st = b['state']
        _reg = parse_env_file(f'{STATE_DIR}/t{b["task"]}.pipeline')
        reg_prof = _reg.get('PROFILE', '')
        pe = prof_env(reg_prof)
        alive = b['app'] == 'running'
        fe_port = st.get('FE_PORT') or _reg.get('FE_PORT')
        api_port = st.get('API_PORT') or _reg.get('API_PORT')

        out = ['<div class="strip" data-key="strip">']

        # 1) Стенд — один индикатор; что именно под ним, видно по наведению
        det = []
        if b['app']:
            det.append(f'app={b["app"]}')
        if b['fe']:
            det.append(f'fe={b["fe"]}')
        if b['status'] == 'run':
            det.append('horizon ' + ('✓' if b['horizon'] else '✗'))
            det.append(', '.join(f'{q} {n}' for q, n in b['queues'][:3]) if b['queues'] else 'очереди пусты')
        if b['status'] in ('up', 'stall') and b['stages']:
            last = b['stages'][-1].split('|')
            det.append('этап: ' + (last[2] if len(last) > 2 else last[-1]))
        tip = html.escape(' · '.join(det)) if det else 'нет данных о контейнерах'

        if alive or b['status'] == 'run':
            dot, cls, label = '&#9679;', 'st-good', 'стенд работает'
        elif b['status'] == 'up':
            dot, cls, label = '&#9679;', 'st-info', 'стенд поднимается'
        elif b['status'] == 'stall':
            dot, cls, label = '&#9888;', 'st-critical', 'стенд не поднялся'
        else:
            dot, cls, label = '&#9675;', 'st-warn', 'стенд не поднят'
        out.append(f'<span class="{cls}" title="{tip}">{dot} {label}</span>')

        # 2) Ссылки на стенд — по одной, без повторов
        links = []
        if fe_port:
            links.append(f'<a target="_blank" rel="noopener" href="http://localhost:{fe_port}">фронт :{fe_port}</a>')
        if api_port and api_port != fe_port:
            links.append(f'<a target="_blank" rel="noopener" href="http://localhost:{api_port}">API :{api_port}</a>')
        if not links and pe['STAND_URL'] and alive:
            links.append(f'<a target="_blank" rel="noopener" href="{pe["STAND_URL"]}">'
                         f'{pe["STAND_URL"].replace("http://", "")}</a>')
        if links:
            out.append('<span>' + ' · '.join(links) + '</span>')

        # 2а) Снос стенда — только руками и только пока он жив. Движок песочницу больше
        # не сносит (раньше это молча делало ретро): после отгрузки стенд часто ещё нужен —
        # посмотреть результат, переснять демо, проверить руками.
        if alive:
            out.append(f'<button class="sbdown" onclick="sandboxDown(\'{b["task"]}\')" '
                       'title="Снести песочницу задачи: контейнеры, схемы БД и ClickHouse, '
                       'рабочая копия. Поднять обратно — только полным подъёмом">'
                       '&#9211; Снести стенд</button>')

        # 3) Ветка и объём правок — только там, где ветка на задачу вообще есть
        if b['branch']:
            n = b['dirty']
            word = 'файл' if n % 10 == 1 and n % 100 != 11 else (
                'файла' if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14 else 'файлов')
            chg = (f' <span class="dim" title="изменённых файлов в рабочей копии задачи '
                   f'(git status)">· {n} {word} изменено</span>' if n
                   else ' <span class="dim" title="рабочая копия чиста">· без изменений</span>')
            out.append(f'<span class="br">{html.escape(b["branch"])}{chg}</span>')

        # 4) Предупреждения — здесь, а не в шапке (собраны при рендере шапки)
        for cls_, text, why in b.get('alerts', []):
            t = f' title="{html.escape(why)}"' if why else ''
            out.append(f'<span class="badge {cls_}"{t}>{text}</span>')

        out.append('</div>')
        return ''.join(out)

    pipe_tasks = set()
    pipe_boxes = [(b, st_by_task.get(b['task'])) for b in boxes]
    pipe_boxes = [(b, s) for b, s in pipe_boxes if s]

    def _rank(item):
        b, s = item
        waits = any(v in ('wait', 'premature') for v in s.values())
        runs = any(v == 'run' for v in s.values())
        return (0 if waits else 1 if runs else 2, len(b['task']), b['task'])

    pipe_boxes.sort(key=_rank)
    need_me = sum(1 for _, s in pipe_boxes if any(v in ('wait', 'premature') for v in s.values()))
    if pipe_boxes:
        hint = (f' <span class="needme">&#9203; ждут тебя: {need_me}</span>' if need_me else '')
        p.append(f'<h2 id="tasks">Задачи в работе <span class="cnt">{len(pipe_boxes)}</span>{hint}</h2>')
        for b, st in pipe_boxes:
            pipe_tasks.add(b['task'])
            pf_b = parse_env_file(f'{STATE_DIR}/t{b["task"]}.pipeline')
            stall = pipeline_stall(b['task'], pf_b, st)
            lm = pipeline_last_move(b['task'], pf_b)
            unmarked = (lm and time.time() - lm < 180
                        and not any(s in ('run', 'wait') for s in st.values())
                        and pf_b.get('RETRO') != 'done')
            if stall:
                mode = 'stall' if stall[1] == 'hard' else 'idle'
                st = {n: (mode if s == 'run' else s) for n, s in st.items()}
            state_cls = ' attn' if any(s == 'wait' for s in st.values()) else (' act' if any(s == 'run' for s in st.values()) else '')
            if stall:
                state_cls = ' attn'
            _reg = parse_env_file(f'{STATE_DIR}/t{b["task"]}.pipeline')
            route = _reg.get('ROUTE', '')
            profile = _reg.get('PROFILE', '')   # схему конвейера даёт профиль проекта
            pf_card = _reg
            toks = sum(int(v) for k, v in pf_card.items() if k.startswith('TOKENS_') and v.isdigit())
            info = get_task_info(b['task']) or {}

            # ── Шапка: СНАЧАЛА суть задачи, служебное — мелкой строкой под ней.
            # Раньше номер, проект, маршрут, название, кнопки и предупреждения стояли в один ряд
            # и читались как сплошная лента.
            waits_me = any(v in ('wait', 'premature') for v in st.values())
            p.append(f'<div class="card wide{state_cls}" data-key="task-{b["task"]}" '
                     f'data-profile="{html.escape(b["profile"] or "—")}"'
                     f'{" data-wait=1" if waits_me else ""}>'
                     f'<div class="hdr" data-key="hdr">')
            p.append('<div class="hmain">')
            title = re.sub(r'^[^|]*\|\s*', '', info.get('title') or '').replace(' | ', ' · ')
            if title:
                p.append(f'<div class="tline"><span class="ttl" title="{html.escape(info.get("title", ""))}">'
                         f'{html.escape(title)}</span>'
                         f'<a class="tinfo" onclick="openFrame(\'/task/t{b["task"]}\')" '
                         f'title="описание задачи">{ICON_DOC}</a></div>')
            else:
                p.append(f'<div class="tline"><span class="ttl">Задача #{b["task"]}</span></div>')
            meta = [f'#{b["task"]}']
            if b['profile']:
                meta.append(html.escape(b['profile']))
            if route:
                meta.append(route_badge(route))
            if toks:
                meta.append(f'{toks / 1e6:.1f}M ткн')
            p.append(f'<div class="meta">{" · ".join(meta)}</div>')
            done_n, total_n, cur_label, cur_kind = progress_of(st, route, profile)
            if total_n:
                pct = int(done_n * 100 / total_n)
                # точка у активного этапа: с одного взгляда видно, где идёт работа,
                # а где задача просто стоит и ждёт человека
                dot = '<i class="livedot"></i>' if cur_kind == 'run' else ''
                where = (f'<span class="pw pw-{cur_kind}">{dot}{html.escape(cur_label)}</span>'
                         if cur_label else '')
                p.append(f'<div class="prg pk-{cur_kind}" title="пройдено этапов маршрута">'
                         f'<span class="pbar"><i style="width:{pct}%"></i></span>'
                         f'<span class="pnum">{done_n}/{total_n}</span>{where}</div>')
            p.append('</div>')

            # ── Действия: таймер и кнопка запуска — отдельным блоком справа
            p.append('<span class="tctl">')
            orch = pf_card.get('ORCH_PID', '')
            alive = orch and os.path.isdir(f'/proc/{orch}')
            # Задача, стоящая на воротах, ждёт РЕШЕНИЯ, а не запуска: «Продолжить» там сбивает с толку
            # (конвейер жив и никуда не денется). Показываем то действие, которого от человека ждут.
            gate_wait_key = next((k for k in ('GATE_PLAN', 'GATE_CAUSE', 'GATE_ACCEPT')
                                  if pf_card.get(k) == 'waiting'), None)
            if gate_wait_key:
                where_doc = {'GATE_PLAN': ('/plan/t', 'план'), 'GATE_CAUSE': ('/diag/t', 'диагноз')}.get(
                    gate_wait_key, ('/report/t', 'результат'))
                p.append(f'<button class="runbtn gate" onclick="openFrame(\'{where_doc[0]}{b["task"]}\')" '
                         f'title="конвейер ждёт твоего решения — открыть {where_doc[1]}">'
                         f'&#9998; Решить: {where_doc[1]}</button>')
            elif not alive and pf_card.get('RETRO') != 'done':
                p.append(f'<button class="runbtn" onclick="runTask(\'{b["task"]}\')" '
                         f'title="запустить/продолжить конвейер (нужен открытый VS Code)">&#9654; Продолжить</button>')
            tmr = get_timer(b['task'])
            if tmr:
                on = ' on' if tmr['running'] else ''
                btn, act, hint = (ICON_PAUSE, 'pause', 'пауза') if tmr['running'] else (ICON_PLAY, 'start', 'старт')
                p.append(f'<span class="tmr{on}" data-run="{1 if tmr["running"] else 0}" data-el="{tmr["elapsed"]}">'
                         f'{ICON_CLOCK}<b class="tval">{fmt_hms(tmr["elapsed"])}</b></span>')
                p.append(f'<button class="tbtn{on}" onclick="timerAct(\'{b["task"]}\',\'{act}\')" '
                         f'title="{hint}" aria-label="{hint} таймера задачи {b["task"]}">{btn}</button>')
            p.append('</span>')

            # ── Предупреждения собираем здесь, а показываем в подвале: в шапке они забивали заголовок
            alerts = []
            # Демон умер, а этап помечен запущенным: работать некому, но реестр этого не знает
            # и задача «выполняется» бесконечно. Молчать нельзя — человек узнаёт об этом,
            # только когда сам спросит (#8060: замер висел мёртвым 16 минут).
            #
            # Но живого ORCH_PID недостаточно как признак работы: конвейер часто ведут РУКАМИ
            # из чата, там демона нет вовсе, а реестр обновляется через pipeline-set.sh.
            # Поэтому смерть = мёртвый PID И застывший реестр (#7787: алерт врал сутки,
            # пока задача активно двигалась вручную). Порог 30 минут: дольше без единой
            # отметки в реестре не идёт ни один этап конвейера.
            try:
                idle_sec = time.time() - os.path.getmtime(f'{STATE_DIR}/t{b["task"]}.pipeline')
            except OSError:
                idle_sec = 0
            if not alive and idle_sec > 1800 and pf_card.get('RETRO') != 'done' and any(s == 'run' for s in st.values()):
                alerts.append(('st-critical', '&#9760; демон умер — этап висит',
                               'работа этапа потеряна, нужен «Продолжить»'))
            if any(s == 'wait' for s in st.values()):
                # «Ждёт тебя» без расшифровки бесполезно: человек видит, что стоит, но не знает,
                # ЧЕГО от него хотят, и идёт спрашивать. Называем действие и сколько уже ждём.
                what = {
                    'GATE_PLAN': 'утвердить план работ',
                    'GATE_CAUSE': 'подтвердить диагноз',
                    'GATE_ACCEPT': 'принять работу — проверить в браузере',
                }.get(gate_wait_key or '', 'решение по этапу')
                waited = f' · {human_age(idle_sec)}' if idle_sec > 60 else ''
                alerts.append(('st-serious', f'&#9203; ждёт тебя: {what}{waited}',
                               'конвейер не встал — он остановлен на воротах и ждёт твоего ответа'))
            if stall and stall[1] == 'hard':
                alerts.append(('st-critical', f'&#9888; стоит {stall[0]} мин', ''))
            elif stall:
                alerts.append(('st-serious', f'&#10074;&#10074; тихо {stall[0]} мин', ''))
            elif unmarked:
                alerts.append(('st-info', '&#9679; агент работает', 'этап не размечен реестром'))
            if pf_b.get('STALLED_HUMAN') == '1':
                alerts.append(('st-critical', '&#9888; застряла — нужен человек', 'авто-resume не помог'))
            if st.get('_returned'):
                alerts.append(('st-serious', '&#8635; возврат в Build', 'замечания приёмки'))
            if parse_env_file(f'{STATE_DIR}/t{b["task"]}.pipeline').get('WF_STATUS') == 'stopped':
                alerts.append(('st-serious', '&#9209; остановлен человеком',
                               f'продолжить: scripts/factory.sh --resume {b["task"]}'))
            lf = loop_facts(b['task'])
            if lf['halted']:
                nm = (node_title(lf['halted'], profile)
                      if lf['halted'] in graph_of(route, profile)['pos'] else lf['halted'])
                alerts.append(('st-critical',
                               f'&#9940; конвейер остановлен на этапе «{html.escape(nm)}» — нужен человек',
                               html.escape(lf['halt_msg']) + ': агент не смог свести замеры, работа стоит'))
            elif lf['loops']:
                where = ', '.join(
                    f"{node_title(k, profile) if k in graph_of(route, profile)['pos'] else k} \u00d7{v}"
                    for k, v in lf['loops'].items())
                alerts.append(('st-serious', f'&#8635; возвраты: {html.escape(where)}',
                               'этап не сошёлся с замерами и переделывался'))
            # Задача на воротах: показываем, ЧТО именно прошло — чтобы решение принималось по
            # карточке, а не после раскопок в отчёте. «Ревью ✓ trace ✓ линт ✓ браузер ✓» — этого
            # обычно достаточно, чтобы нажать «Принять» осознанно.
            if st.get('gate_accept') == 'wait':
                checks = [(node_title(n, profile), st.get(n))
                          for n in ('tests', 'review', 'trace', 'php', 'lint', 'browser', 'measure')
                          if n in graph_of(route, profile)['pos'] and st.get(n) not in (None, 'pending')]
                if checks:
                    mark = {'done': '\u2713', 'skip': '\u2014', 'skipbad': '\u26a0', 'stall': '\u26a0'}
                    line = ' \u00b7 '.join(f'{nm} {mark.get(s, s)}' for nm, s in checks)
                    alerts.append(('st-good', f'\u2713 пройдено: {html.escape(line)}',
                                   'что уже проверено — на этом основании принимается решение'))
            bad = [node_title(nid, profile) for nid in graph_of(route, profile)['pos']
                   if st.get(nid) in ('skipbad', 'premature')]
            if bad:
                names = ', '.join(bad)   # подпись этапа целиком: «Тесты (red-first)», а не «(red-first)»
                alerts.append(('st-critical', f'&#9888; не пройдено: {html.escape(names)}',
                               'обязательный этап не пройден — приёмка преждевременна'))
            # Один прогон — один главный статус. Раньше плашки просто копились, и карточка
            # одновременно кричала «агент работает», «застряла», «остановлен человеком» и
            # «конвейер остановлен» — человек не мог понять, что происходит на самом деле.
            def _has(txt):
                return any(txt in a[1] for a in alerts)
            if _has('остановлен человеком'):
                alerts = [a for a in alerts if 'остановлен человеком' in a[1] or 'не пройдено' in a[1]]
            elif _has('конвейер остановлен'):
                alerts = [a for a in alerts if 'конвейер остановлен' in a[1] or 'возвраты' in a[1]
                          or 'не пройдено' in a[1]]
            elif _has('агент работает') or _has('ждёт тебя'):
                alerts = [a for a in alerts if 'застряла' not in a[1] and 'стоит' not in a[1]]
            b['alerts'] = alerts
            p.append('</div>')
            plan_exists = os.path.exists(f'{STATE_DIR}/t{b["task"]}.plan.md')
            p.append('<div class="gwrap" data-key="graph">'
                     + render_graph(st, task=b['task'], plan_exists=plan_exists, route=route, profile=profile)
                     + '</div>')
            p.append(sandbox_strip(b))
            p.append('</div>')

    # --- Песочницы БЕЗ конвейера (data-only, ручные) ---
    loose = [b for b in boxes if b['task'] not in pipe_tasks]
    if loose or not boxes:
        p.append('<h2>Песочницы вне конвейера</h2>')
    if loose:
        p.append('<div class="grid">')
        for b in loose:
            icon, label, cls = BADGES[b['status']]
            p.append('<div class="card">')
            p.append(f'<div class="hdr"><b>t{b["task"]}</b><span class="badge {cls}">{icon} {label}</span></div>')
            if b['status'] in ('up', 'stall') and b['stages']:
                last = b['stages'][-1].split('|')
                step = last[1] if len(last) > 1 else ''
                desc = last[2] if len(last) > 2 else last[-1]
                mm = re.match(r'^(\d+)/(\d+)$', step)
                pct = int(int(mm.group(1)) / int(mm.group(2)) * 100) if mm else 0
                p.append(f'<div class="meter"><i style="width:{pct}%"></i></div>')
                p.append(f'<div class="sub">этап {html.escape(step)}: {html.escape(desc)}</div>')
            else:
                p.append(sandbox_strip(b))
            p.append('</div>')
        p.append('</div>')
    elif not boxes:
        p.append('<div class="empty">Нет живых песочниц. Поднять: <code>up.sh &lt;номер задачи&gt;</code></div>')

    if orphans:
        p.append('<h2>Хвосты (схемы без реестра)</h2>')
        p.append('<div class="orph">&#9888; ' + ', '.join(html.escape(o) for o in orphans) + ' — снести: <code>down.sh &lt;task&gt; --data-only</code></div>')

    b24s = get_b24_stats() or {}
    outside = [t for t in b24s.get('running_tasks', []) if str(t.get('id')) not in {b['task'] for b in boxes}]
    if outside:
        p.append('<h2>Таймер идёт вне фабрики</h2><div class="grid">')
        for t in outside:
            tid = html.escape(str(t['id']))
            short = re.sub(r'^[^|]*\|\s*', '', t.get('title') or '').replace(' | ', ' · ')
            p.append('<div class="card">')
            p.append(f'<div class="hdr"><b>#{tid}</b>'
                     f'<span class="ttl" title="{html.escape(t.get("title") or "")}">{html.escape(short)}</span>'
                     f'<span class="tctl"><span class="tmr on" data-run="1" data-el="{int(t.get("elapsed", 0))}">{ICON_CLOCK}<b class="tval">{fmt_hms(int(t.get("elapsed", 0)))}</b></span>'
                     f'<button class="tbtn on" onclick="timerAct(\'{tid}\',\'pause\')" title="пауза">{ICON_PAUSE}</button></span></div>')
            p.append('</div>')
        p.append('</div>')
    p.append('</div>')
    waits = []
    for b, st in pipe_boxes:
        for nid in ('gate_plan', 'gate_accept'):
            if st.get(nid) == 'wait':
                waits.append(f'{b["task"]}:{nid}')
        pfw = parse_env_file(f'{STATE_DIR}/t{b["task"]}.pipeline')
        stw = pipeline_stall(b['task'], pfw, st)
        if stw and stw[1] == 'hard':
            waits.append(f'{b["task"]}:stall')
    p.append(f'<span id="waits" data-w="{html.escape(",".join(waits))}" style="display:none"></span>')
    p.append('</div>')  # /#app — граница живого обновления
    # Модалка плана: iframe на /plan/tNNNN (вне #app — поллинг её не трогает)
    p.append('<div id="modal"><div class="mbox"><span class="mclose" onclick="closePlan()">&#10005;</span>'
             '<iframe id="planframe"></iframe></div></div>')
    p.append('<script>'
             'function openFrame(u){document.getElementById("planframe").src=u;'
             'document.getElementById("modal").classList.add("open");}'
             'function openPlan(t){openFrame("/plan/t"+t);}'
             'function openActivity(t){openFrame("/activity/t"+t);}'
             # Клик по ЛЮБОЙ фигуре схемы: своё окно этапа вместо чужого документа
             'function openStage(t,n){openFrame("/stage/t"+t+"/"+n);}'
             'function closePlan(){document.getElementById("modal").classList.remove("open");}'
             'document.getElementById("modal").addEventListener("click",function(e){if(e.target.id==="modal")closePlan();});'
             'document.addEventListener("keydown",function(e){if(e.key==="Escape")closePlan();});'
             'function toggleTheme(){var t=(localStorage.getItem("factory-theme")||"dark")==="dark"?"light":"dark";'
             'localStorage.setItem("factory-theme",t);document.documentElement.dataset.theme=t;}'
             'function setLive(ok){var e=document.querySelector(".live");if(!e)return;'
             'e.textContent=ok?"● LIVE":"■ FAIL";e.style.color=ok?"":"var(--critical)";'
             'e.style.textShadow=ok?"":"0 0 9px var(--critical)";}'
             'async function poll(){if(document.hidden)return;'
             'try{var r=await fetch(location.href,{cache:"no-store"});var t=await r.text();'
             'var d=new DOMParser().parseFromString(t,"text/html");var a=d.getElementById("app");'
             'if(!r.ok)throw new Error(r.status);'
             'if(a){patch(document.getElementById("app"),a);applyOpen();}setLive(true);}catch(e){setLive(false);}}'
             'function patch(cur,nxt){'
             'var oc=Array.prototype.slice.call(cur.children),nc=Array.prototype.slice.call(nxt.children);'
             'var ok=oc.map(function(c,i){return c.dataset.key||("#"+i);});'
             'var nk=nc.map(function(c,i){return c.dataset.key||("#"+i);});'
             'if(ok.join(",")!==nk.join(",")){cur.innerHTML=nxt.innerHTML;return;}'
             'for(var i=0;i<nc.length;i++){if(oc[i].outerHTML===nc[i].outerHTML)continue;'
             'if(oc[i].querySelector("[data-key]")&&nc[i].querySelector("[data-key]"))patch(oc[i],nc[i]);'
             'else oc[i].replaceWith(document.adoptNode(nc[i]));}}'
             'setInterval(poll,5000);'
             'function toggleLoops(){var v=document.documentElement.dataset.loops==="on"?"off":"on";'
             'localStorage.setItem("factory-loops",v);document.documentElement.dataset.loops=v;}'
             'document.documentElement.dataset.loops=localStorage.getItem("factory-loops")||"off";'
             'function toggleView(){var v=document.documentElement.dataset.view==="compact"?"full":"compact";'
             'localStorage.setItem("factory-view",v);document.documentElement.dataset.view=v;}'
             'document.documentElement.dataset.view=localStorage.getItem("factory-view")||"full";'
             # раскрытые карточки помним: страница перерисовывается каждые 5 с и после F5,
             # и без этого раскрытая схема схлопывалась обратно
             'function openSet(){try{return new Set(JSON.parse(localStorage.getItem("factory-open")||"[]"));}'
             'catch(e){return new Set();}}'
             'function applyOpen(){var s=openSet();'
             'document.querySelectorAll(".card[data-key]").forEach(function(c){'
             'c.classList.toggle("open",s.has(c.dataset.key));});}'
             'document.addEventListener("click",function(e){var h=e.target.closest(".hdr .hmain");'
             'if(!h||document.documentElement.dataset.view!=="compact")return;'
             'if(e.target.closest("a,button"))return;'
             'var c=h.closest(".card");if(!c)return;'
             'var s=openSet();if(s.has(c.dataset.key))s.delete(c.dataset.key);else s.add(c.dataset.key);'
             'localStorage.setItem("factory-open",JSON.stringify([...s]));applyOpen();});'
             'applyOpen();'
             'function setProject(p){localStorage.setItem("factory-project",p);'
             'document.documentElement.dataset.project=p;}'
             'document.documentElement.dataset.project='
             '  localStorage.getItem("factory-project")||"all";'
             'if("Notification" in window && Notification.permission==="default")Notification.requestPermission();'
             'function notifyWaits(){var el=document.getElementById("waits");if(!el)return;'
             'var cur=(el.dataset.w||"").split(",").filter(Boolean);'
             'var seen=(localStorage.getItem("factory-notified")||"").split(",").filter(Boolean);'
             'cur.forEach(function(w){if(seen.indexOf(w)<0 && Notification.permission==="granted"){'
             'var p=w.split(":");var b=p[1]==="stall"?"конвейер стоит без движения!":(p[1]==="gate_plan"?"план ждёт утверждения":"результат ждёт приёмки");new Notification("Фабрика: задача #"+p[0],{body:b,tag:w});}});'
             'localStorage.setItem("factory-notified",cur.join(","));}'
             'notifyWaits();setInterval(notifyWaits,5100);'
             'function timerAct(t,a){fetch("/api/timer/t"+t+"/"+a,{method:"POST"}).then(function(){poll();});}'
             # Снос стенда: подтверждение с ПОЛНЫМ перечнем последствий. Отменить снос
             # нельзя, а поднять заново — это минуты полного up, поэтому спрашиваем прямо.
             'function sandboxDown(t){if(!confirm("Снести стенд задачи #"+t+"?\\n\\n'
             'Будут удалены: контейнеры песочницы, её схемы MySQL и ClickHouse, рабочая копия задачи.\\n'
             'Поднять обратно можно только полным подъёмом стенда (несколько минут).\\n'
             'Ветка задачи и коммиты не пострадают; незакоммиченные правки worktree снос остановят."))return;'
             'var b=event.target;b.textContent="сношу…";b.disabled=true;'
             'fetch("/api/sandbox/t"+t+"/down",{method:"POST"}).then(function(r){return r.json();})'
             '.then(function(d){b.textContent=d.ok?"● снос идёт":("ошибка: "+(d.msg||""));'
             'if(!d.ok)b.disabled=false;setTimeout(poll,5000);})'
             '.catch(function(){b.textContent="ошибка";b.disabled=false;});}'
             # Ответ сервера тут ВАЖЕН: при живом демоне запуска не будет (второй процесс),
             # и рисовать «● запущен» — врать. Показываем, что ответили.
             'function runTask(t){var b=event.target;b.textContent="запускаю…";b.disabled=true;'
             'fetch("/api/run/t"+t,{method:"POST"}).then(function(r){return r.json();}).then(function(d){'
             'if(d.ok){b.textContent="● запущен";setTimeout(poll,3000);}'
             'else{b.textContent="уже работает";b.title=d.msg||"";setTimeout(poll,1500);}})'
             '.catch(function(){b.textContent="ошибка";b.disabled=false;});}'
             'setInterval(function(){document.querySelectorAll(".tmr[data-run=\'1\']").forEach(function(el){'
             'var s=parseInt(el.dataset.el)+1;el.dataset.el=s;'
             'var p=[Math.floor(s/3600),Math.floor(s%3600/60),s%60].map(function(x){return String(x).padStart(2,"0")});'
             'var v=el.querySelector(".tval");if(v)v.textContent=p.join(":");});},1000);'
             '</script></body></html>')
    return ''.join(p)


def md_inline(s):
    """Инлайн-разметка: сначала эскейп, потом **жирный** и `код`."""
    s = html.escape(s, quote=False)
    s = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', s)
    s = re.sub(r'`([^`]+)`', r'<code>\1</code>', s)
    return s


def md2html(md):
    """Минимальный markdown -> HTML: заголовки, списки (-, 1.), абзацы."""
    out, mode = [], None  # mode: None | 'ul' | 'ol'

    def close():
        nonlocal mode
        if mode:
            out.append(f'</{mode}>')
            mode = None

    # Пустая строка между пунктами списка закрывала его, и каждый пункт становился
    # отдельным <ol> — нумерация в плане шла «1., 1., 1.» вместо «1., 2., 3.».
    # Теперь разрыв откладываем: если следом идёт пункт того же типа, список продолжается.
    lines = md.splitlines()
    for i, raw in enumerate(lines):
        line = raw.rstrip()
        if not line.strip():
            nxt = next((l for l in lines[i + 1:] if l.strip()), '')
            same_list = ((mode == 'ol' and re.match(r'^\s*\d+\.\s+', nxt))
                         or (mode == 'ul' and re.match(r'^\s*-\s+', nxt)))
            if not same_list:
                close()
            continue
        m = re.match(r'^(#{1,4})\s+(.*)$', line)
        if m:
            close()
            lvl = len(m.group(1))
            out.append(f'<h{lvl + 1}>{md_inline(m.group(2))}</h{lvl + 1}>')
            continue
        m = re.match(r'^!\[([^\]]*)\]\(([^)]+)\)$', line.strip())
        if m:
            close()
            url = m.group(2)
            if url.endswith(('.mp4', '.webm')):
                out.append(f'<video controls src="{html.escape(url, quote=True)}" '
                           f'style="max-width:100%;border:1px solid var(--cardline);border-radius:var(--r-md);margin:6px 0"></video>')
            else:
                out.append(f'<img src="{html.escape(url, quote=True)}" alt="{html.escape(m.group(1))}" '
                           f'style="max-width:100%;border:1px solid var(--cardline);border-radius:var(--r-md);margin:6px 0">')
            continue
        m = re.match(r'^\s*-\s+(.*)$', line)
        if m:
            if mode != 'ul':
                close()
                out.append('<ul>')
                mode = 'ul'
            out.append(f'<li>{md_inline(m.group(1))}</li>')
            continue
        m = re.match(r'^\s*\d+\.\s+(.*)$', line)
        if m:
            if mode != 'ol':
                close()
                out.append('<ol>')
                mode = 'ol'
            out.append(f'<li>{md_inline(m.group(1))}</li>')
            continue
        close()
        out.append(f'<p>{md_inline(line)}</p>')
    close()
    return ''.join(out)


def tail_agent_log(path, n=14):
    """Последние события транскрипта агента в человекочитаемом виде.

    Окно чтения РАСТЁТ, пока не наберётся n событий: у браузерных этапов одна запись
    (скриншот, evaluate) весит сотни килобайт, и в фиксированные 200 КБ помещалось
    2-3 строки — страница активности выглядела пустой при живом агенте.
    """
    events = []
    lines = []
    try:
        size = os.path.getsize(path)
        for window in (200_000, 1_000_000, 4_000_000, 12_000_000):
            with open(path, 'rb') as f:
                f.seek(max(0, size - window))
                lines = f.read().decode('utf-8', 'replace').splitlines()
            # событий в этом окне достаточно? считаем грубо, по маркеру содержимого
            if sum(1 for x in lines if '"content"' in x) >= n or window >= size:
                break
    except OSError:
        return events
    for line in lines:
        try:
            d = json.loads(line)
        except Exception:
            continue
        msg = d.get('message') or {}
        content = msg.get('content')
        if not isinstance(content, list):
            continue
        for c in content:
            t = c.get('type')
            if t == 'tool_use':
                inp = json.dumps(c.get('input', {}), ensure_ascii=False)
                events.append(('tool', f"{c.get('name','?')} {inp[:160]}"))
            elif t == 'text' and c.get('text', '').strip():
                events.append(('text', c['text'].strip()[:200]))
    return events[-n:]


def render_activity(task):
    """Живой лог активного агента: жив ли, что делает прямо сейчас."""
    pf = parse_env_file(f'{STATE_DIR}/t{task}.pipeline')
    # ACTIVE_DIR ставится оркестратором на каждый этап; если его нет —
    # активный workflow почти всегда тот, чей JOURNAL указан в реестре
    adir = pf.get('ACTIVE_DIR', '') or os.path.dirname(pf.get('JOURNAL', ''))
    body = []
    files = []
    if adir and os.path.isdir(adir):
        files = sorted((f for f in os.listdir(adir) if f.startswith('agent-') and f.endswith('.jsonl')),
                       key=lambda f: os.path.getmtime(os.path.join(adir, f)))
    # У задач, начатых по старой схеме, в реестре остаётся путь к журналу ПРОШЛОГО прогона.
    # Он старше текущего orch.log — и страница показывала архив вместо живой работы.
    orch_path = f'{STATE_DIR}/logs/t{task}.orch.log'
    if files and os.path.exists(orch_path):
        newest_old = max(os.path.getmtime(os.path.join(adir, f)) for f in files)
        if os.path.getmtime(orch_path) > newest_old:
            files = []
    if not files:
        # Оркестратор гоняет один выбранный runner на этап, и его поток пишется в
        # logs/tN.orch.log. Если отдельного ACTIVE_DIR нет, показываем активность оттуда.
        orch = f'{STATE_DIR}/logs/t{task}.orch.log'
        if os.path.exists(orch):
            age = int(time.time() - os.path.getmtime(orch))
            # Этапы берём из МАРШРУТА профиля: захардкоженный список знал не все этапы,
            # и на линте или php-чеке заголовок молчал о том, что вообще происходит.
            stages = profile_stages(pf.get('PROFILE', '')).get(pf.get('ROUTE', '')) or []
            # Запасной путь — только по этапам ВСЕХ маршрутов профиля: иначе в заголовок
            # попадали служебные ключи реестра (WF_STATUS=running — это не этап).
            known = {s for ss in profile_stages(pf.get('PROFILE', '')).values() for s in ss}
            stage = next((k for k in stages if pf.get(k) == 'running'), '') \
                or next((k for k in known if pf.get(k) == 'running'), '')
            if age < 30:
                live = '<span class="st-good">&#9679; активен</span>'
            elif age < 150:
                live = '<span class="st-serious">&#9679; думает/долгий шаг</span>'
            else:
                live = '<span class="st-critical">&#9888; нет активности — возможно завис</span>'
            body.append(f'<p>{live} · последняя запись <b>{human_age(age)} назад</b>'
                        + (f' · этап <b>{html.escape(stage)}</b>' if stage else '') + '</p>')
            body.append('<div class="alog">')
            for kind, text in tail_agent_log(orch):
                icon = '&#8594;' if kind == 'tool' else '&#128172;'
                body.append(f'<div class="ae ae-{kind}">{icon} {html.escape(text)}</div>')
            body.append('</div>')
        else:
            body.append('<p class="sub">Агент ещё не запускался — лога этапов нет.</p>')
    else:
        newest = os.path.join(adir, files[-1])
        age = int(time.time() - os.path.getmtime(newest))
        if age < 30:
            live = '<span class="st-good">&#9679; активен</span>'
        elif age < 150:
            live = '<span class="st-serious">&#9679; думает/долгий шаг</span>'
        else:
            live = '<span class="st-critical">&#9888; нет активности — возможно завис</span>'
        body.append(f'<p>{live} · последняя запись <b>{human_age(age)} назад</b> · файл {html.escape(files[-1])} · агентов в workflow: {len(files)}</p>')
        body.append('<div class="alog">')
        for kind, text in tail_agent_log(newest):
            icon = '&#8594;' if kind == 'tool' else '&#128172;'
            body.append(f'<div class="ae ae-{kind}">{icon} {html.escape(text)}</div>')
        body.append('</div>')
    return (f'<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta http-equiv="refresh" content="3">'
            f'<title>Агент t{task}</title><style>{CSS}{DOC_CSS}'
            '.alog{margin-top:10px;display:flex;flex-direction:column;gap:4px}'
            # Строки лога длинные (JSON-аргументы инструментов): держим одну строку с многоточием,
            # по наведению разворачиваем целиком. Раньше текст просто обрывался о край карточки.
            '.ae{font:12px ui-monospace,monospace;color:var(--ink2);border-left:2px solid var(--cardline);'
            'padding:3px 10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
            '.ae:hover{white-space:pre-wrap;word-break:break-word;background:var(--card2);'
            'border-radius:0 6px 6px 0}'
            '.ae-tool{color:var(--ink);border-left-color:var(--codenode)}'
            '.ae-text{border-left-color:var(--good)}'
            f'</style><script>if (window.self !== window.top) document.documentElement.classList.add("in-frame");</script></head><body><div id="app"><div class="top"><h1>&#129302; Агент задачи #{html.escape(task)}</h1></div>'
            f'<div class="card wide" style="margin-top:12px">{"".join(body)}</div>'
            '<div class="sub" style="margin-top:8px">обновляется каждые 3 с</div></div></body></html>')


# ---------- Окно этапа (клик по любой фигуре схемы) ----------

# Значения реестра, которые понимает движок (core.sh: run_stage и gate_wait), — они же
# доступны для ручного перевода. Список намеренно закрытый: произвольная строка для движка
# означает «этап без статуса», и он гоняет этап заново (по три попытки на круг).
STAGE_VALUES = [
    ('pending', 'не начинался'), ('running', 'выполняется'), ('done', 'завершён'),
    ('waiting', 'ждёт человека'), ('approved', 'утверждён (ворота)'),
    ('skipped', 'пропущен'), ('failed', 'провален'),
]
# Расшифровка сырого значения реестра. Человек читает схему, а не реестр, — 'approved'
# сам по себе ему ничего не говорит.
STAGE_VALUE_RU = dict(STAGE_VALUES, rejected='отклонён человеком', blocked='заблокирован')
# Телеметрия этапа: что означают соседние ключи реестра (см. pipeline-set.sh)
_STAGE_SUFFIX_RU = {'AT': 'переход в текущий статус', 'VIA': 'через что решено',
                    'COMMENT': 'замечания человека', 'FAILS': 'провалов накопилось'}
_STAGE_PREFIX_RU = {'DUR': 'агент работал, мин', 'FANOUT': 'субагентов запущено',
                    'TOKENS': 'токенов потрачено'}

# Хвост движка: этих этапов нет в PROFILE_ROUTE_STAGES_*, но bin/factory гоняет их сам
# сразу после конвейера (ship при approved-приёмке → ретро). В маршрут профиля их не кладут
# намеренно: run_pipeline прогнал бы их второй раз. Без этого списка окно этапа врало
# «этап вне маршрута движка» на Merge/Ship и Ретро.
# DEMO здесь нет и быть не должно: демо убрано из цепочки (решение человека 2026-07-27) и
# снимается отдельно — кнопкой плагина «Демо» в кокпите (`factory <TASK> demo`). Ключ DEMO
# в реестре остаётся, но этапом конвейера он не является: дашборд его не ведёт и не ждёт.
ENGINE_TAIL_KEYS = ('SHIP', 'RETRO')

def pipeline_set(task, key, value):
    """Privileged control-запись через общий writer — lib/pipeline-set.sh.

    Свой upsert в дашборде пришлось бы держать в согласии с правилами движка (метка KEY_AT,
    счётчик KEY_FAILS, подмена живого реестра архивным у отгруженной задачи) — две копии
    правил разъезжаются на первой же правке.
    """
    script = os.path.join(FACTORY_HOME, 'lib', 'pipeline-set.sh')
    try:
        r = subprocess.run(['bash', script, str(task), key, value], capture_output=True,
                           text=True, timeout=15, env=dict(os.environ, STATE_DIR=STATE_DIR))
        return r.returncode == 0, (r.stderr or '').strip()
    except Exception as e:                                   # noqa: BLE001
        return False, str(e)


def factory_resume(task):
    """Продолжить конвейер задачи — единственная точка запуска движка из дашборда.

    Тот же вызов, что у кнопки «▶ Продолжить» на карточке: движок умеет только
    start|resume. Держим в одном месте, чтобы кнопки этапов и кнопка карточки не разъехались.
    """
    fac = os.path.join(FACTORY_HOME, 'bin', 'factory')
    return run([fac, str(task), 'resume'], timeout=30)


def resume_first_stage(pf, profile, route):
    """Какой этап РЕАЛЬНО возьмёт `factory <TASK> resume` при текущем реестре.

    Кнопка «начать этап» обязана говорить правду: движок идёт по маршруту и берёт первый
    незакрытый этап, а не тот, чьё окно открыл человек. Повторяем его порядок: сначала
    этапы маршрута (run_pipeline), затем хвост bin/factory (ship → ретро).
    Возврат: (ключ реестра или None, пояснение).
    """
    for k in profile_stages(profile).get(route or '', []):
        v = pf.get(k, '')
        if v in ('done', 'skipped'):
            continue
        if k.startswith('GATE_'):
            if v == 'approved':
                continue
            return k, 'ворота: ждут решения человека'
        return k, ''
    if pf.get('GATE_ACCEPT') == 'approved' and pf.get('SHIP') != 'done':
        return 'SHIP', ''
    if pf.get('SHIP') == 'done' and pf.get('RETRO') != 'done':
        return 'RETRO', ''
    return None, ''


def daemon_state(task, pf):
    """Жив ли демон конвейера этой задачи. Возврат: (pid, жив ли, сколько минут работает).

    Это главный предохранитель от второго запуска: пока демон жив, любой «запусти этап»
    из дашборда породил бы второго агента на том же этапе — ровно тот инцидент, из-за
    которого в bin/factory уже стоит двойной гард (один процесс пишет «готово», другой
    «не начато», и на схеме этап мигает).

    Проверяем не только /proc/<pid>, но и КОМАНДНУЮ строку: PID переиспользуются, и «жив»
    по одному каталогу — это запрет работы из-за случайного чужого процесса.
    """
    pid = (pf.get('ORCH_PID') or '').strip()
    if not pid.isdigit() or not os.path.isdir(f'/proc/{pid}'):
        return pid, False, 0
    try:
        with open(f'/proc/{pid}/cmdline', 'rb') as f:
            cmd = f.read().replace(b'\0', b' ').decode('utf-8', 'replace')
    except OSError:
        return pid, False, 0
    if 'bin/factory' not in cmd or str(task) not in cmd.split():
        return pid, False, 0
    try:
        mins = max(0, int((time.time() - os.path.getmtime(f'/proc/{pid}')) / 60))
    except OSError:
        mins = 0
    return pid, True, mins


STALE_RUN_SEC = 1800     # столько же, сколько у алерта «демон умер — этап висит»


def registry_idle_sec(task):
    """Сколько секунд в реестре задачи не менялось НИЧЕГО (последняя запись статуса).

    Признак «этап действительно завис»: конвейер иногда ведут руками из чата, там демона
    нет вовсе, но статусы идут. Живым считаем то, что пишет в реестр, а не то, у чего есть PID.
    """
    try:
        return time.time() - os.path.getmtime(f'{STATE_DIR}/t{task}.pipeline')
    except OSError:
        return 0


def work_in_progress(task, pf, profile, route):
    """Идёт ли ПРЯМО СЕЙЧАС работа по задаче. Возврат: (да/нет, чем именно занято).

    Два независимых признака, и оба нужны:
      - жив демон конвейера (ORCH_PID) — обычный автоматический прогон;
      - какой-то этап в статусе running при свежем реестре — так выглядит прогон, который
        ведут РУКАМИ из чата: демона нет вовсе, а статусы идут (см. алерт «демон умер»).
    Застывший running без демона работой не считаем: это зависший этап, его надо давать
    перезапускать, иначе человек заперт без единой кнопки.
    """
    pid, alive, mins = daemon_state(task, pf)
    if alive:
        return True, f'демон конвейера жив (pid {pid}, {mins} мин)'
    idle = registry_idle_sec(task)
    if idle < STALE_RUN_SEC:
        running = next((k for k in engine_order(profile, route) if pf.get(k) == 'running'), None)
        if running:
            return True, (f'этап {running} выполняется, последняя запись в реестре '
                          f'{int(idle / 60)} мин назад (конвейер ведут вручную, без демона)')
    return False, ''


def engine_order(profile, route):
    """Порядок этапов глазами движка: маршрут профиля + хвост bin/factory."""
    route_keys = list(profile_stages(profile).get(route or '', []))
    return route_keys + [k for k in ENGINE_TAIL_KEYS if k not in route_keys]


def engine_stage_key(nid, key, profile, route):
    """Каким ключом ЭТОТ узел зовётся у движка (а не на схеме).

    Схема и движок иногда зовут этап по-разному: узел «План» показывает PLANS (его пишет
    агент по ходу планирования), а run_pipeline гоняет этап PLAN. Кнопка «начать этап»
    обязана писать тот ключ, который движок реально читает, иначе она нажимается вхолостую.
    """
    order = engine_order(profile, route)
    if key in order:
        return key
    return nid.upper() if nid.upper() in order else key


def stage_action(task, nid, action):
    """Кнопка-действие из окна этапа: перевести этап в pending и запустить движок.

    Смысл: человеку показывают язык задачи («начать этап»), а не внутреннюю механику
    реестра. Но врать нельзя — движок берёт ПЕРВЫЙ незакрытый этап маршрута. Поэтому
    перед записью пересчитываем, что реально пойдёт первым, и resume дёргаем ТОЛЬКО
    если это ровно то, что обещала кнопка. Иначе честно объясняем, где конвейер сейчас.

    Возврат: (ok, сообщение человеку, запущен ли движок).
    """
    pf_path = f'{STATE_DIR}/t{task}.pipeline'
    if not os.path.exists(pf_path):
        # Без этой проверки pipeline-set.sh СОЗДАСТ реестр-призрак и дашборд «воскресит» задачу
        return False, 'реестра задачи нет — действовать не над чем', False
    pf = parse_env_file(pf_path)
    profile, route = pf.get('PROFILE', ''), pf.get('ROUTE', '')
    meta = profile_graph_meta(profile, route)
    key = engine_stage_key(nid, meta['keys'].get(nid, nid.upper()), profile, route)

    if action != 'run':
        return False, f'неизвестное действие: {action}', False
    if key not in engine_order(profile, route):
        return False, f'этап {key} не входит в маршрут {route or "—"} — движок его не запустит', False

    # ── ПРЕДОХРАНИТЕЛИ. Все — ДО любой записи в реестр и до запуска движка.
    # Сервер обязан отказывать сам: кнопку можно нажать дважды, страницу — открыть в двух
    # вкладках, ссылку — дёрнуть curl'ом. Полагаться на то, что UI спрятал кнопку, нельзя.
    pid, alive, mins = daemon_state(task, pf)
    idle = registry_idle_sec(task)
    busy, why_busy = work_in_progress(task, pf, profile, route)
    if pf.get(key) == 'running' and busy:
        # Второй агент на том же этапе = два процесса пишут статусы наперегонки.
        # Отказ снимается сам собой, когда этап явно завис (ниже) — или вручную,
        # кнопкой в блоке «Реестр вручную»: она ничего не запускает и остаётся открытой.
        return False, (f'этап {key} уже выполняется — второй раз запускать нельзя '
                       f'({why_busy}). Если он всё-таки завис, сними статус в блоке '
                       '«Реестр вручную» и запусти снова'), False
    if busy:
        return False, (f'по этой задаче уже идёт работа ({why_busy}). Второй запуск породил бы '
                       'второго агента: два процесса пишут статусы наперегонки. Дождись '
                       'окончания (или останови демон), потом запускай'), False
    if alive:
        return False, (f'конвейер этой задачи уже работает: демон жив (pid {pid}, {mins} мин). '
                       'Второй запуск породил бы второго агента — дождись окончания или '
                       'останови демон, потом запускай'), False

    # Сначала СИМУЛИРУЕМ запись и смотрим, что взял бы движок. Реально писать «этап в pending»
    # ради отказа нельзя: сброс готового этапа без запуска — это порча реестра за спиной человека.
    first, why = resume_first_stage(dict(pf, **{key: 'pending'}), profile, route)
    if first != key:
        if first is None:
            return False, 'запускать нечего: конвейер уже прошёл маршрут до конца', False
        return False, (f'движок возьмёт не этот этап, а {first}'
                       + (f' ({why})' if why else '')
                       + ' — он идёт раньше по маршруту. Реестр не тронут: сначала закрой '
                         'тот этап (или переведи его в skipped), потом запускай этот'), False

    ok, msg = pipeline_set(task, key, 'pending')
    if not ok:
        return False, f'не записалось ({key}=pending): {msg}', False
    factory_resume(task)
    stale = (' Этап числился выполняющимся, но движения не было '
             f'{int(idle / 60)} мин и демона нет — перезапускаю как зависший.'
             if pf.get(key) == 'running' else '')
    return True, 'запускаю этап — движок запущен, статус обновится через несколько секунд.' + stale, True


def sandbox_down(task):
    """Снос песочницы задачи — ТЕМ ЖЕ путём, что у движка: profile_sandbox_down профиля.

    Движок больше не сносит стенд сам (ретро его не трогает): песочница — ресурс человека,
    после отгрузки её открывают посмотреть результат и переснять демо. Решение «снести» —
    только руками, отсюда.

    Процесс запускаем отдельно и НЕ ждём: снос идёт минутами (docker rm, DROP схем, удаление
    worktree), а ответ кнопке нужен сразу — иначе она «висит», человек жмёт второй раз и
    получает два сноса. Ход виден в журнале задачи, итог — по индикатору стенда: контейнеров
    не стало, точка гаснет сама на ближайшем обновлении страницы.
    """
    pf = parse_env_file(f'{STATE_DIR}/t{task}.pipeline')
    profile = pf.get('PROFILE', '')
    path = os.path.join(PROFILES_DIR, profile, 'profile.sh')
    if not profile or not os.path.exists(path):
        return False, f'профиль задачи неизвестен ({profile or "—"}) — сносить нечем'
    core = os.path.join(FACTORY_HOME, 'lib', 'core.sh')
    script = (f'source "{core}"; source "{path}"; '
              'declare -F profile_sandbox_down >/dev/null || exit 3; '
              f'profile_sandbox_down {int(task)}')
    try:
        subprocess.Popen(
            ['bash', '-c', script],
            env=dict(os.environ, STATE_DIR=STATE_DIR, FACTORY_PROFILES_DIR=PROFILES_DIR),
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
        return True, 'снос запущен'
    except Exception as e:                                   # noqa: BLE001
        return False, str(e)


def stage_launch(task, nid, key, route, profile):
    """(команда, честное пояснение) для ручного запуска этапа.

    Движок (bin/factory) знает только start|resume — он проходит ВЕСЬ маршрут, пропуская
    done/skipped. Команды «выполни вот этот один этап» у него нет, и выдумывать её здесь
    нельзя: кнопка, дёргающая несуществующий API, врёт человеку. Поэтому — готовая команда
    в буфер и прямой текст о том, что именно она сделает.
    """
    stages = profile_stages(profile).get(route or '', [])
    fac = os.path.join(FACTORY_HOME, 'bin', 'factory')
    if key in stages or key in ENGINE_TAIL_KEYS:
        cmd = f'{fac} {task} resume'
        note = ('Движок умеет запускать только конвейер целиком (<code>start</code>/'
                '<code>resume</code>) — отдельного «выполни этот этап» у него нет. '
                '<code>resume</code> идёт по маршруту и берёт первый этап, который не '
                '<i>done</i> и не <i>skipped</i>. Чтобы переиграли ИМЕННО этот этап — сначала '
                'переведи его кнопкой выше в <b>pending</b> (и всё, что после него, тоже), '
                'потом запускай. Та же кнопка «▶ Продолжить» есть на карточке задачи.')
        return cmd, note
    note = (f'Этап не входит в маршрут <b>{html.escape(route or "—")}</b> — движок его не '
            'запустит ни при каком resume. Либо смени маршрут задачи, либо выставь статус вручную.')
    return '', note


def render_stage(task, nid):
    """Окно этапа: что это, в каком состоянии, когда перешло, документ, журнал, ручной перевод.

    До этого окна по схеме можно было только «провалиться» в чужой документ: клик вешался
    выборочно, и любая фигура открывала приёмку. Теперь у каждой фигуры своё окно, а действия
    над этапом (в т.ч. ручной перевод статуса) живут в нём.
    """
    pf = parse_env_file(f'{STATE_DIR}/t{task}.pipeline')
    profile, route = pf.get('PROFILE', ''), pf.get('ROUTE', '')
    kind, label, sub = node_def(nid, profile)
    meta = profile_graph_meta(profile, route)          # маппинг узел→ключ уже есть — берём его
    key = meta['keys'].get(nid, nid.upper())
    raw = pf.get(key, '')

    # Состояние узла именно так, как его видит схема (с воротами, гардами и «преждевременно»)
    c_app, _ = stand_containers(profile, task)
    sb = 'run' if docker_state(c_app) == 'running' else 'down'
    st = pipeline_statuses(task, sb, profile=profile, route=route) or {}
    node_st = st.get(nid, 'pending')

    body = []
    body.append(f'<div class="shead"><span class="skind sk-{kind}">'
                f'{ {"agent": "агент", "code": "код", "human": "человек"}.get(kind, kind) }</span>'
                f'<b class="slabel">{html.escape(label)}</b>'
                + (f'<span class="ssub">{html.escape(sub)}</span>' if sub else '') + '</div>')
    st_ru = STAGE_VALUE_RU.get(raw, raw) if raw else 'в реестре нет записи'
    body.append(f'<div class="srow"><span class="sk">Состояние</span>'
                f'<span class="sv ns-{node_st}"><b>{html.escape(st_ru)}</b> · '
                f'{html.escape(NODE_STATE_HINT.get(node_st, node_st))}</span></div>')
    body.append(f'<div class="srow"><span class="sk">Ключ реестра</span>'
                f'<span class="sv mono">{html.escape(key)}={html.escape(raw or "—")}</span></div>')
    # Схема и движок иногда зовут этап по-разному (узел «План» → PLANS, этап движка → PLAN).
    # Показываем оба, иначе человек видит пустой ключ у явно пройденного этапа.
    run_key = engine_stage_key(nid, key, profile, route)
    if run_key != key:
        body.append(f'<div class="srow"><span class="sk">Ключ движка</span>'
                    f'<span class="sv mono">{html.escape(run_key)}='
                    f'{html.escape(pf.get(run_key, "") or "—")}'
                    ' <span class="dim">· этим ключом этап гоняет конвейер</span></span></div>')
    # «Вне маршрута» считаем по ключу ДВИЖКА: у «Плана» схема зовёт этап PLANS, а движок — PLAN,
    # и прямое сравнение с маршрутом объявляло пройденный этап чужим.
    body.append(f'<div class="srow"><span class="sk">Маршрут</span>'
                f'<span class="sv">{route_badge(route) or "—"}'
                + ('' if run_key in engine_order(profile, route)
                   else ' <span class="warn">· этап вне маршрута движка</span>') + '</span></div>')

    # ── История: метки времени и телеметрия этого этапа (KEY_AT, KEY_VIA, DUR_KEY, ...)
    hist = []
    for k, v in pf.items():
        if k == key or not v:
            continue
        suf = k[len(key) + 1:] if k.startswith(key + '_') else ''
        pre = k.rsplit('_' + key, 1)[0] if k.endswith('_' + key) else ''
        title = _STAGE_SUFFIX_RU.get(suf, '') or _STAGE_PREFIX_RU.get(pre, '')
        if not title:
            if suf:
                title = suf.lower()
            else:
                continue
        extra = ''
        if suf == 'AT' or k.endswith('_AT'):
            try:
                ts = time.mktime(time.strptime(v, '%Y-%m-%d %H:%M:%S'))
                extra = f' <span class="dim">({human_age(time.time() - ts)} назад)</span>'
            except ValueError:
                pass
        hist.append(f'<div class="srow"><span class="sk">{html.escape(title)}</span>'
                    f'<span class="sv"><span class="mono">{html.escape(v[:300])}</span>{extra}'
                    f' <span class="dim">· {html.escape(k)}</span></span></div>')
    body.append('<h3 class="sh">История этапа</h3>')
    if hist:
        body += hist
    else:
        body.append('<div class="sub">Меток времени нет: этап ещё не переходил в статус, '
                    'либо прогон шёл по прежней схеме записи.</div>')

    # ── Журнал: строки движка про ЭТОТ этап + ссылка на живой лог агентов
    lines = []
    lp = f'{STATE_DIR}/logs/t{task}.stages.log'
    if os.path.exists(lp):
        try:
            with open(lp, errors='ignore') as f:
                lines = [l.rstrip() for l in f if key in l][-8:]
        except OSError:
            lines = []
    body.append('<h3 class="sh">Журнал</h3>')
    if lines:
        body.append('<div class="slog">'
                    + ''.join(f'<div class="ae">{html.escape(l)}</div>' for l in lines) + '</div>')
    else:
        body.append('<div class="sub">Записей движка про этот этап в журнале нет.</div>')
    body.append(f'<div class="sbtns"><a class="sbtn" href="/activity/t{task}">'
                '&#129302; Открыть журнал агентов</a>')
    doc_url, doc_what = stage_doc_url(nid, task)
    if doc_url:
        body.append(f'<a class="sbtn doc" href="{doc_url}">&#128203; Открыть документ: {doc_what}</a>')
    body.append('</div>')

    # ── ДЕЙСТВИЕ: то, ради чего окно открывают. Языком задачи, а не реестра, и одной кнопкой:
    # человеку не должно приходиться угадывать, что «переиграть этап» — это выставить ключ
    # в pending, а потом отдельно нажать «Продолжить» на карточке (замечание владельца).
    body.append('<h3 class="sh">&#9654; Действие</h3>')
    first_key, first_why = resume_first_stage(pf, profile, route)
    key2nid = {v: k for k, v in meta['keys'].items()}
    # Предохранители видны и здесь: кнопку прячем ровно там, где сервер откажет (см. stage_action).
    pid, dmn_alive, dmn_mins = daemon_state(task, pf)
    idle_min = int(registry_idle_sec(task) / 60)
    # Признак работы — тот же, что у сервера (work_in_progress): кнопку прячем ровно там,
    # где stage_action откажет. Иначе UI обещает то, что сервер не сделает.
    busy, why_busy = work_in_progress(task, pf, profile, route)
    stage_running = pf.get(run_key, raw) == 'running' and busy
    stage_stale = pf.get(run_key, raw) == 'running' and not busy
    busy_note = (f'{html.escape(why_busy)}. '
                 f'<a href="/activity/t{task}">Смотреть журнал агентов</a>.')

    def _stage_ref(k):
        """Ссылка на окно этапа по ключу реестра — чтобы «иди закрой вон тот» был кликабельным."""
        n = key2nid.get(k, k.lower())
        return f'<a href="/stage/t{task}/{n}">{html.escape(node_def(n, profile)[1])}</a>'

    if kind == 'human':
        # Прочие ворота: решение принимается на странице документа, где человек видит,
        # ЧТО он утверждает. Дублировать «принять/отклонить» здесь — плодить вторую правду.
        doc_url, doc_what = stage_doc_url(nid, task)
        if doc_url:
            body.append(f'<div class="sub">Это ворота: решение принимается там, где виден его '
                        f'предмет — на странице «{html.escape(doc_what)}». Кнопки «принять» и '
                        f'«отклонить» живут там.</div>'
                        f'<div class="sbtns"><a class="sbtn doc go" href="{doc_url}">'
                        f'&#128203; Открыть {html.escape(doc_what)} и решить</a></div>')
        else:
            body.append('<div class="sub">Это ворота — здесь ждут решения человека. '
                        'Отдельной страницы решения у них нет: ответ ставится вручную ниже.</div>')
    else:
        # Этапы агента и кода: «Начать этап». Движок умеет только resume, а resume берёт ПЕРВЫЙ
        # незакрытый этап маршрута — поэтому кнопка активна лишь тогда, когда это и есть наш этап.
        order = engine_order(profile, route)
        in_route = run_key in order
        # Наш этап пойдёт первым, если он не позже того, что движок возьмёт сейчас: сброс
        # в pending делает первым именно его. Позже — соврать нельзя, кнопку не даём.
        if not in_route or first_key is None:
            will_run = in_route
        elif first_key in order:
            will_run = order.index(run_key) <= order.index(first_key)
        else:
            will_run = False
        if not in_route:
            body.append(f'<div class="sub warn">Этап не входит в маршрут '
                        f'<b>{html.escape(route or "—")}</b> — движок не запустит его ни при каком '
                        'resume. Либо смени маршрут задачи, либо выставь статус вручную ниже.</div>')
        elif stage_running:
            # Кнопки нет вовсе: второй агент на том же этапе — это два процесса, пишущих
            # статусы наперегонки (из-за этого в bin/factory уже стоит гард на двойной демон).
            body.append('<div class="sub warn">&#9210; Этап выполняется прямо сейчас — запускать '
                        'второй раз нечего и опасно: получится два агента на одном этапе. '
                        + busy_note + ('' if dmn_alive else
                           ' Если движение прекратилось, сними статус в блоке «Реестр вручную» '
                           'ниже — тогда появится кнопка запуска.') + '</div>')
        elif busy:
            body.append('<div class="sub warn">&#9210; Запускать нельзя: ' + busy_note
                        + ' Второй запуск породил бы второго агента. Дождись, пока движок дойдёт '
                          'до этого этапа сам.</div>')
        elif will_run:
            # «Переиграть» или «начать» — по значению ключа ДВИЖКА: у «Плана» ключ схемы пуст,
            # и кнопка звала «начать» уже пройденный этап.
            again = pf.get(run_key, raw) in ('done', 'skipped', 'failed')
            if stage_stale:
                body.append(f'<div class="sub warn">&#9888; Этап числится выполняющимся, но демона '
                            f'нет и реестр не менялся {idle_min} мин — похоже, он завис (агент убит '
                            'или демон умер). Кнопка ниже перезапустит его с начала.</div>')
            body.append('<div class="sub">Кнопка переведёт этап в <i>pending</i> и продолжит '
                        'конвейер — движок возьмёт именно его' + (', переиграв прошлый результат.'
                                                                  if again else '.') + '</div>')
            body.append('<div class="sbtns">'
                        f'<button class="sbtn go" onclick="act(\'run\',\'{"Переиграть" if again else "Начать"} '
                        f'этап {html.escape(label)}? Запустится агент движка.\')">&#9654; '
                        + ('Переиграть этап' if again else 'Начать этап') + '</button></div>')
        else:
            body.append('<div class="sub warn">Запустить именно этот этап сейчас нельзя: '
                        'движок идёт по маршруту и возьмёт первый незакрытый этап — сейчас это '
                        + _stage_ref(first_key) + (f' ({html.escape(first_why)})' if first_why else '')
                        + '. Закрой его (или переведи в <i>skipped</i>), тогда очередь дойдёт '
                          'и сюда. Реестр кнопкой не портим.</div>')
    body.append('<div class="sub actmsg" id="actmsg"></div>')

    # ── Ручной перевод статуса
    body.append('<h3 class="sh">Реестр вручную (нештатный случай)</h3>')
    body.append('<div class="sub">Это «сырой» доступ к реестру задачи, а не основной способ '
                'работы: кнопки просто пишут значение ключа <code>' + html.escape(key) + '</code> '
                'через <code>pipeline-set.sh</code>, ничего не запуская. Нужны, когда штатное '
                'действие выше не подходит: снять зависший <i>running</i>, пропустить этап, '
                'починить реестр после сбоя. Движок увидит новое значение на следующем круге.'
                '</div>')
    if busy:      # застывший running сюда не попадает: там работы нет, реестр править безопасно
        # Частое заблуждение: «переведу в done — этап остановится». Не остановится: агент живёт
        # своей жизнью, допишет свой статус позже и перетрёт ручной. Пишем это прямо здесь.
        body.append('<div class="sub warn">&#9888; Сейчас идёт работа: '
                    + html.escape(why_busy)
                    + '. Перевод в <i>done</i> или <i>skipped</i> НЕ останавливает агента: он '
                      'доработает и запишет свой статус поверх твоего, а этап на схеме прыгнет '
                      'обратно. Чтобы действительно прервать — останови демон конвейера '
                      f'(<code>kill {html.escape(pid) if dmn_alive else "&lt;pid&gt;"}</code>), '
                      'и только потом правь реестр.</div>')
    body.append('<div class="sbtns">')
    for val, ru in STAGE_VALUES:
        cur = ' cur' if val == raw else ''
        body.append(f'<button class="sbtn{cur}" onclick="setStage(\'{val}\')" '
                    f'title="{key}={val}">{html.escape(ru)}<span class="vraw">{val}</span></button>')
    body.append('</div>')

    # ── Запуск этапа: у всего, что выполняет агент. Ромбы (линт, php-чек) — тоже этапы
    # маршрута и гоняются тем же run_stage через claude, поэтому раздел им положен так же,
    # как прямоугольникам; у ворот (human) запускать нечего — там решение человека.
    if kind in ('agent', 'code'):
        cmd, note = stage_launch(task, nid, key, route, profile)
        body.append('<h3 class="sh">Та же команда в терминале (запасной путь)</h3>')
        body.append(f'<div class="sub">Нужна, когда дашборд недоступен или хочется видеть вывод '
                    f'движка своими глазами. Обычный путь — кнопка «Действие» выше. {note}</div>')
        if cmd:
            body.append(f'<pre class="cmd" id="cmd">{html.escape(cmd)}</pre>'
                        '<div class="sbtns"><button class="sbtn" id="cpb" onclick="copyCmd()">'
                        '&#10697; Скопировать команду</button></div>')
    css = (
        '.shead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}'
        '.slabel{font-size:19px}'
        '.skind{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink2);'
        'border:1px solid var(--cardline);border-radius:var(--r-pill);padding:2px 10px}'
        '.ssub{font-size:12px;color:var(--ink2)}'
        '.srow{display:flex;gap:14px;padding:6px 0;border-top:1px solid var(--cardline);font-size:13px}'
        '.sk{flex:0 0 190px;color:var(--ink2)}.sv{color:var(--ink)}'
        '.sv.ns-run b,.sv.ns-wait b{color:var(--serious)}.sv.ns-done b{color:var(--good)}'
        '.sv.ns-stall b,.sv.ns-skipbad b,.sv.ns-premature b{color:var(--critical)}'
        '.dim{color:var(--ink2)}.warn{color:var(--serious)}'
        '.mono{font:12px ui-monospace,monospace}'
        '.sh{font-size:13px;margin:22px 0 8px;color:var(--good);text-transform:uppercase;'
        'letter-spacing:.08em}'
        '.sbtns{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}'
        '.sbtn{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--cardline);'
        'border-radius:var(--r-md);background:none;color:var(--ink);cursor:pointer;'
        'padding:6px 14px;font:13px ui-monospace,monospace;text-decoration:none}'
        '.sbtn:hover{border-color:var(--good);color:var(--good)}'
        '.sbtn.cur{border-color:var(--good);color:var(--good);background:#39d3531a}'
        '.sbtn.doc{border-color:var(--serious);color:var(--serious)}'
        # Главное действие окна видно сразу: остальные кнопки здесь — служебные
        '.sbtn.go{border-color:var(--good);color:var(--good);background:#39d3531a;font-size:14px;'
        'padding:8px 18px}'
        '.sbtn.go:hover{box-shadow:0 0 11px #39d35344}'
        '.sbtn:disabled{opacity:.5;cursor:default;border-color:var(--cardline);color:var(--ink2)}'
        '.actmsg:empty{display:none}'
        '.actmsg{margin-top:10px;padding:9px 12px;border:1px solid var(--cardline);'
        'border-radius:var(--r-md);background:var(--card2)}'
        '.vraw{font-size:11px;color:var(--ink2)}'
        '.slog{display:flex;flex-direction:column;gap:4px;margin-top:6px}'
        '.cmd{margin:10px 0 0;padding:12px 14px;border:1px solid var(--cardline);'
        'border-radius:var(--r-md);background:var(--card2);font:12px ui-monospace,monospace;'
        'color:var(--ink);white-space:pre-wrap;word-break:break-all}'
    )
    js = ('<script>'
          f'var T="{task}",N="{nid}";'
          'function setStage(v){if(!confirm("Перевести этап в «"+v+"»? Меняется реестр задачи."))return;'
          'fetch("/api/stage/"+T+"/"+N+"/"+v,{method:"POST"}).then(function(r){return r.json();})'
          '.then(function(d){if(d.ok)location.reload();else alert("Не записалось: "+(d.msg||""));})'
          '.catch(function(e){alert("Не записалось: "+e);});}'
          # Действие = решение + запуск одним кликом. Движок стартует не мгновенно (демон,
          # флок, чтение профиля), поэтому сначала честное «запускаю…», потом перезагрузка окна.
          'function act(a,q){if(q&&!confirm(q))return;var b=event.target,old=b.textContent;'
          'b.disabled=true;b.textContent="\\u2026 запускаю";'
          'fetch("/api/act/"+T+"/"+N+"/"+a,{method:"POST"}).then(function(r){return r.json();})'
          '.then(function(d){var m=document.getElementById("actmsg");if(m)m.textContent=d.msg||"";'
          'b.textContent=d.started?"\\u25cf запущено":(d.ok?"\\u2713 записано":old);'
          'if(!d.ok)b.disabled=false;'
          'setTimeout(function(){location.reload();},d.started?4000:2500);})'
          '.catch(function(e){b.textContent=old;b.disabled=false;alert("Не получилось: "+e);});}'
          'function copyCmd(){var el=document.getElementById("cmd"),b=document.getElementById("cpb");'
          'function ok(){b.textContent="\\u2713 скопировано";setTimeout(function(){'
          'b.textContent="\\u29c9 Скопировать команду";},2000);}'
          'if(navigator.clipboard)navigator.clipboard.writeText(el.textContent).then(ok,sel);else sel();'
          'function sel(){var r=document.createRange();r.selectNode(el);'
          'getSelection().removeAllRanges();getSelection().addRange(r);'
          'b.textContent="выдели и скопируй вручную";}}'
          'if (window.self !== window.top) document.documentElement.classList.add("in-frame");'
          '</script>')
    return (f'<!doctype html><html lang="ru"><head><meta charset="utf-8">'
            f'<title>Этап {html.escape(label)} · t{task}</title>'
            f'<style>{CSS}{DOC_CSS}{css}</style>{js}</head>'
            f'<body><div id="app"><div class="top"><h1>&#9881; Этап задачи #{html.escape(task)}</h1>'
            f'<a class="back" href="/" target="_top" style="margin-left:auto">&larr; на дашборд</a></div>'
            f'<div class="card wide" style="margin-top:12px">{"".join(body)}</div></div></body></html>')


def desc_to_html(text):
    """Описание задачи B24 -> безопасный HTML. Портал отдаёт вперемешку:
    готовый HTML (<span>, <a>, <br>), BBCode ([URL=..]) и голые URL —
    приводим всё к тексту с кликабельными ссылками."""
    t = text or ''
    links = []

    def keep(url, label):
        links.append((url.strip(), (label or url).strip()))
        return f'\x00L{len(links) - 1}\x00'

    # переносы из HTML
    t = re.sub(r'<br\s*/?>|</p>|</div>', '\n', t, flags=re.I)
    # <a href> и [URL=..] — в плейсхолдеры до зачистки тегов
    t = re.sub(r'<a[^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>',
               lambda m: keep(m.group(1), re.sub(r'<[^>]+>', '', m.group(2))), t, flags=re.S | re.I)
    t = re.sub(r'\[URL=([^\]]+)\](.*?)\[/URL\]',
               lambda m: keep(m.group(1), m.group(2)), t, flags=re.S | re.I)
    # остальные теги и BB-разметку — в мусор
    t = re.sub(r'<[^>]+>', '', t)
    t = re.sub(r'\[/?(?:COLOR|B|I|U|SIZE|FONT|P|DIV)[^\]]*\]', '', t, flags=re.I)
    t = html.escape(html.unescape(t))
    # голые URL — тоже ссылками
    t = re.sub(r'(?<!\x00)(https?://[^\s<]+)', lambda m: keep(m.group(1), m.group(1)), t)
    for i, (url, label) in enumerate(links):
        a = f'<a href="{html.escape(url, quote=True)}" target="_blank">{html.escape(label)}</a>'
        t = t.replace(f'\x00L{i}\x00', a)
    t = re.sub(r'\n{3,}', '\n\n', t).strip()
    return t.replace('\n', '<br>') or '(без описания)'


def render_task_info(task):
    info = get_task_info(task) or {}
    rows = []
    for label, key in (('Статус', 'status_label'), ('Дедлайн', 'deadline'), ('Группа', 'group_name'),
                       ('Постановщик', 'creator'), ('Ответственный', 'responsible')):
        if info.get(key):
            rows.append(f'<span>{label}</span><span>{html.escape(str(info[key]))}</span>')
    link = f'<a href="https://b24.discript.ru{html.escape(info["url"])}" target="_blank">открыть в B24 &#8599;</a>' if info.get('url') else ''
    return (f'<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Задача {task}</title>'
            f'<style>{CSS}{DOC_CSS}</style><script>if (window.self !== window.top) document.documentElement.classList.add("in-frame");</script></head><body><div id="app">'
            f'<div class="top"><h1>&#128196; #{html.escape(task)} · {html.escape(info.get("title", "?"))}</h1></div>'
            f'<div class="sub">{link}</div>'
            f'<article class="doc card wide"><div class="kv" style="margin-bottom:14px">{"".join(rows)}</div>'
            f'<p>{desc_to_html(info.get("description", ""))}</p></article></div></body></html>')


def plan_from_journal(task):
    """План из journal.jsonl workflow: human_doc переводчика (результаты в журнале
    без меток — распознаём по форме объекта)."""
    pf = parse_env_file(f'{STATE_DIR}/t{task}.pipeline')
    j = pf.get('JOURNAL', '')
    translator, skeptic = None, None
    try:
        with open(j, encoding='utf-8') as f:
            for line in f:
                d = json.loads(line)
                if d.get('type') != 'result' or not isinstance(d.get('result'), dict):
                    continue
                r = d['result']
                if 'human_doc' in r:
                    translator = r
                elif 'final_plan' in r:
                    skeptic = r
    except OSError:
        return None
    if translator:
        md = translator['human_doc']
        if skeptic and skeptic.get('unresolved'):
            md += '\n\n## Вопросы скептика\n' + '\n'.join(f'{i}. {u}' for i, u in enumerate(skeptic['unresolved'], 1))
        return md
    if skeptic:
        fp = skeptic.get('final_plan', {})
        parts = ['# План (черновой вид — переводчик ещё не отработал)\n']
        for grp, ttl in (('backend_changes', 'Backend'), ('frontend_changes', 'Frontend')):
            items = (fp.get('spec') or {}).get(grp) or []
            if items:
                parts.append(f'## {ttl}\n' + '\n'.join(f"- `{c.get('file','?')}` — {c.get('change','')}" for c in items))
        if skeptic.get('unresolved'):
            parts.append('## Вопросы\n' + '\n'.join(f'{i}. {u}' for i, u in enumerate(skeptic['unresolved'], 1)))
        return '\n\n'.join(parts)
    return None


def render_routes():
    """Маршруты ВСЕХ проектов фабрики. Схема и состав этапов берутся из профиля: движок
    собственных маршрутов не имеет, а страница без профиля рисовала пустые холсты."""
    DESCR = {
        'feature': 'Новая функциональность: разведка → два конкурирующих плана → скептик → '
                   'ворота плана → тесты (red-first) → сборка → ревью → проверки → приёмка.',
        'debug': 'Любой баг. Сначала понять, потом чинить: воспроизвести с замерами → логи → '
                 'диагноз с цифрами → скептик ломает гипотезу → доказательство экспериментом → '
                 'ворота «причина принята» → фикс → замер ПОСЛЕ.',
        'trivial': 'Однострочник, текст, конфиг: правка → ревью → проверки → приёмка. '
                   'Агент обязан эскалировать, если задача окажется не тривиальной.',
        'dev': 'Обычный прогон: замер → варианты → скептики → синтез → внедрение → регресс → '
               'скриншоты → приёмка.',
        'quick': 'Мелочь с очевидной причиной: сразу внедрить → регресс → показать.',
    }
    profiles = sorted(
        name for name in os.listdir(PROFILES_DIR)
        if os.path.isfile(os.path.join(PROFILES_DIR, name, 'profile.sh'))
    )
    blocks = []
    for prof in profiles:
        routes = profile_stages(prof)
        if not routes:
            continue
        blocks.append(f'<div class="prof">&#128230; {html.escape(prof)}</div>')
        for name in sorted(routes):
            g = graph_of(name, prof)
            st = {n: 'route' for n in g['pos']}
            # Порядок — из МАРШРУТА профиля, а не из схемы: в JSON узлы лежат в порядке
            # рисования, и дописанный позже этап уезжал в конец списка.
            keys_rev = {}
            for node, key in profile_graph_meta(prof)['keys'].items():
                keys_rev.setdefault(key, node)
            chain = []
            for stage in routes[name]:
                nid = keys_rev.get(stage, stage.lower())
                if nid in g['pos'] and nid not in chain:
                    chain.append(nid)
            steps = ' <span class="arr">→</span> '.join(
                (f'<b class="gate">{html.escape(node_title(n, prof))}</b>'
                 if n.startswith('gate_') else html.escape(node_title(n, prof)))
                for n in chain)
            blocks.append(
                f'<h2>{route_badge(name)}<span class="cnt">{len(chain)} этапов</span></h2>'
                + (f'<p class="sub rdesc">{html.escape(DESCR[name])}</p>' if name in DESCR else '')
                + f'<p class="steps">{steps}</p>'
                + f'<div class="card wide">{render_graph(st, route=name, profile=prof)}</div>')
    css = ('.graph .ns-route{opacity:1}.graph .ns-route .mk{fill:transparent}'
           '.prof{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink2);'
           'margin:34px 0 4px;padding-top:18px;border-top:1px solid var(--cardline)}'
           '.prof:first-of-type{border-top:none;padding-top:0;margin-top:18px}'
           '.rdesc{max-width:1100px;margin:2px 0 8px}'
           '.steps{font-size:13px;color:var(--ink2);margin:0 0 12px;line-height:1.9}'
           '.steps .gate{color:var(--serious);font-weight:600}'
           '.steps .arr{opacity:.45}'
           'h2 .cnt{margin-left:8px}'
           '.card.wide{margin-bottom:10px}')
    return (f'<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Маршруты конвейера</title>'
            f'<style>{CSS}{DOC_CSS}{css}</style><script>if (window.self !== window.top) document.documentElement.classList.add("in-frame");</script></head><body><div id="app">'
            f'<div class="top"><h1>&#128506; Маршруты конвейера</h1>'
            f'<a class="back" href="/" target="_top" style="margin-left:auto">&larr; на дашборд</a></div>'
            f'<div class="sub">маршрут выбирает разведка по тому, что нашла в коде</div>'
            f'{"".join(blocks)}</div></body></html>')


def render_tasks():
    """Обзор живых задач: заголовок, ветка, diff, где стоит, ссылки — по одной на строку."""
    cards = []
    tasks = sorted(m.group(1) for f in (os.listdir(STATE_DIR) if os.path.isdir(STATE_DIR) else [])
                   if (m := re.match(r'^t(\d+)\.pipeline$', f)))
    for task in tasks:
        pf = parse_env_file(f'{STATE_DIR}/t{task}.pipeline')
        st = pipeline_statuses(task, 'run', profile=pf.get('PROFILE', '')) or {}
        info = get_task_info(task) or {}
        title = re.sub(r'^[^|]*\|\s*', '', info.get('title', '') or f'#{task}').replace(' | ', ' · ')
        # где сейчас: ждёт-узел важнее бегущего
        done_n, total_n, cur, cur_kind = progress_of(st, pf.get('ROUTE', ''), pf.get('PROFILE', ''))
        if not cur:
            cur = 'готово' if pf.get('RETRO') == 'done' else '—'
        pe = prof_env(pf.get('PROFILE', ''))   # у каждого проекта свои корни репозиториев
        be_wt = pf.get('BE_WT') or f'{pe["BE"]}/worktree-t{task}'
        fe_wt = f'{pe["FE"]}/worktree-t{task}'
        diffs = []
        for lbl, wt in (('BE', be_wt), ('FE', fe_wt)):
            if os.path.isdir(wt):
                stat = run(['git', '-C', wt, 'diff', '--stat', 'HEAD'], timeout=6).splitlines()
                summ = stat[-1].strip() if stat else 'нет изменений'
                untr = run(['git', '-C', wt, 'ls-files', '--others', '--exclude-standard'], timeout=6).splitlines()
                extra = f' · +{len(untr)} новых' if untr else ''
                br = run(['git', '-C', wt, 'branch', '--show-current'], timeout=4)
                # Ветка на сотни файлов — почти всегда след автоформатирования, а не работы задачи
                # (#7900: 282 файла во фронте от eslint --fix). Такое надо видеть до приёмки, а не в PR.
                m = re.match(r'(\d+) files? changed', summ)
                nfiles = int(m.group(1)) if m else 0
                word = 'файл' if nfiles % 10 == 1 and nfiles % 100 != 11 else (
                    'файла' if nfiles % 10 in (2, 3, 4) and nfiles % 100 not in (12, 13, 14) else 'файлов')
                flag = (f' <span class="badge st-critical" title="подозрительно много файлов: '
                        f'проверь, не автоформатирование ли это">&#9888; {nfiles} {word}</span>') if nfiles > 60 else ''
                diffs.append(f'<div class="dl"><b>{lbl}</b> <span class="br">{html.escape(br)}</span> — {html.escape(summ)}{extra}{flag}</div>')
        warn = ''
        if pf.get('STALLED_HUMAN') == '1':
            warn = '<span class="badge st-critical">⚠ застряла</span>'
        elif any(st.get(n) == 'wait' for n in st):
            warn = '<span class="badge st-serious">⏳ ждёт тебя</span>'
        fe_port = pf.get('FE_PORT', '')
        links = []
        if os.path.exists(f'{STATE_DIR}/t{task}.plan.md'):
            links.append(f'<a href="/plan/t{task}" target="_blank">план</a>')
        if os.path.exists(f'{STATE_DIR}/t{task}.report.md'):
            links.append(f'<a href="/report/t{task}" target="_blank">приёмка</a>')
        if fe_port:
            links.append(f'<a href="http://localhost:{fe_port}" target="_blank">стенд :{fe_port}</a>')
        cards.append(
            f'<div class="tcard"><div class="th"><b class="mono">#{task}</b>'
            + (f'<span class="rt">{route_badge(pf.get("ROUTE", ""))}</span>' if pf.get('ROUTE') else '')
            + (f'<span class="pr">&#128230; {html.escape(pf.get("PROFILE", ""))}</span>'
               if pf.get('PROFILE') else '')
            + f'{warn}<span class="cur pw-{cur_kind}">{html.escape(cur)}</span></div>'
            f'<div class="tt">{html.escape(title)}</div>'
            + (f'<div class="prg"><span class="pbar"><i style="width:'
               f'{int(done_n * 100 / total_n)}%"></i></span>'
               f'<span class="pnum">{done_n}/{total_n}</span></div>' if total_n else '')
            + ''.join(diffs)
            + ('<div class="ln">' + ' · '.join(links) + '</div>' if links else '')
            + '</div>')
    body = ('<div class="tgrid">' + ''.join(cards) + '</div>') if cards else \
        '<p class="sub">Активных задач нет.</p>'
    css = ('.tgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(560px,1fr));gap:14px;'
           'margin-top:18px}'
           '.tcard{background:var(--card);border:1px solid var(--cardline);border-radius:var(--r-lg);'
           'padding:var(--sp-4) var(--sp-5);box-shadow:var(--shadow)}'
           '.th{display:flex;align-items:center;gap:10px;margin-bottom:6px}'
           '.th b{font-size:15px}'
           '.rt{font-size:12px;color:var(--ink2)}'
           '.pr{font-size:12px;color:var(--ink2)}'
           '.cur{margin-left:auto;color:var(--info);font-size:12.5px}'
           '.tt{color:var(--ink);font-size:14.5px;line-height:1.45;margin-bottom:10px}'
           '.dl{font:12.5px ui-monospace,monospace;color:var(--ink2);margin:3px 0}'
           '.dl .br{color:var(--serious)}.ln{margin-top:10px;font-size:13px}'
           '.ln a{margin-right:12px}')
    return (f'<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Задачи в работе</title>'
            f'<meta http-equiv="refresh" content="15"><style>{CSS}{DOC_CSS}{css}</style></head>'
            f'<body><div id="app"><div class="top"><h1>&#128203; Задачи в работе</h1>'
            f'<a class="back" href="/" target="_top" style="margin-left:auto">&larr; на дашборд</a></div>'
            f'{body}</div></body></html>')


def human_age(sec):
    """Возраст записи по-человечески: «8 с», «3 мин», «12ч 35м», «2 дн 4ч»."""
    sec = int(sec)
    if sec < 60:
        return f'{sec} с'
    if sec < 3600:
        return f'{sec // 60} мин'
    if sec < 86400:
        return f'{sec // 3600}ч {sec % 3600 // 60:02d}м'
    return f'{sec // 86400} дн {sec % 86400 // 3600}ч'


def render_stats():
    """Статистика фабрики: по живым и архивным реестрам (телеметрия *_AT/_FAILS/TOKENS_*)."""
    rows = []
    for base in (STATE_DIR, os.path.join(STATE_DIR, 'archive')):
        if not os.path.isdir(base):
            continue
        for f in sorted(os.listdir(base)):
            m = re.match(r'^t(\d+)\.pipeline$', f)
            if not m:
                continue
            pf = parse_env_file(os.path.join(base, f))
            task = m.group(1)
            ats = sorted(v for k, v in pf.items() if k.endswith('_AT'))
            dur = ''
            if len(ats) >= 2:
                try:
                    t0 = time.mktime(time.strptime(ats[0], '%Y-%m-%d %H:%M:%S'))
                    t1 = time.mktime(time.strptime(ats[-1], '%Y-%m-%d %H:%M:%S'))
                    dur = f'{int((t1 - t0) // 3600)}ч {int((t1 - t0) % 3600 // 60):02d}м'
                except ValueError:
                    pass
            fails = sum(int(v) for k, v in pf.items() if k.endswith('_FAILS') and v.isdigit())
            toks = sum(int(v) for k, v in pf.items() if k.startswith('TOKENS_') and v.isdigit())
            arch = base.endswith('archive')
            # РАБОТА и ОЖИДАНИЕ — разные вещи. Раньше показывалось «102ч 47м» (от первого этапа
            # до последнего), хотя агенты работали час с небольшим, а остальное задача стояла
            # на воротах. Цифра создавала впечатление, что фабрика чудовищно медленная.
            work_min = sum(int(v) for k, v in pf.items() if k.startswith('DUR_') and v.isdigit())
            work = f'{work_min // 60}ч {work_min % 60:02d}м' if work_min else '—'
            rows.append((task, pf.get('ROUTE', '—'), pf.get('SHIP', pf.get('GATE_ACCEPT', '—')),
                         work, dur or '—', fails, f'{toks / 1e6:.1f}M' if toks else '—',
                         'архив' if arch else 'живая', work_min))
    # Сводка сверху: цифры, ради которых сюда и заходят, — не искать их глазами в таблице
    live = [r for r in rows if r[7] == 'живая']
    mins = [r[8] for r in rows if r[8]]
    avg = f'{sum(mins) // len(mins) // 60}ч {sum(mins) // len(mins) % 60:02d}м' if mins else '—'
    loops = sum(r[5] for r in rows)
    kpi = [('задач всего', len(rows)), ('в работе', len(live)),
           ('среднее время работы', avg), ('возвратов', loops)]
    head = ['<div class="kpis">']
    for label, val in kpi:
        head.append(f'<div class="kpi"><div class="kv">{html.escape(str(val))}</div>'
                    f'<div class="kl">{label}</div></div>')
    head.append('</div>')

    RU = {'pending': 'в работе', 'done': 'завершена', 'waiting': 'ждёт человека',
          'approved': 'принята', 'rejected': 'отклонена', 'running': 'идёт'}
    body = ['<table class="stats"><tr><th>Задача</th><th>Маршрут</th><th>Состояние</th>'
            '<th title="сколько реально работали агенты">Работа</th>'
            '<th title="сколько прошло от старта: включая ожидание решений человека">Прошло</th>'
            '<th>Возвратов</th><th>Токены</th><th></th></tr>']
    for r in rows:
        task, rt, fin, work, dur, fails, toks, kind, _wm = r
        cells = [f'<b class="mono">#{html.escape(task)}</b>',
                 route_badge(rt) if rt != '—' else '—',
                 html.escape(RU.get(fin, fin)),
                 f'<span class="mono">{html.escape(work)}</span>',
                 f'<span class="mono dim">{html.escape(dur)}</span>',
                 str(fails) if fails else '<span class="dim">0</span>',
                 html.escape(toks),
                 f'<span class="tag tag-{"arch" if kind == "архив" else "live"}">{kind}</span>']
        body.append('<tr>' + ''.join(f'<td>{c}</td>' for c in cells) + '</tr>')
    body.append('</table>')
    if not rows:
        body = ['<p class="sub">Пока пусто — статистика появится после первых задач.</p>']
        head = []
    css = (' .stats{width:100%;font-size:13px;border-collapse:collapse}'
           ' .stats th{text-align:left;color:var(--ink2);font-weight:600;padding:0 14px 10px 0;'
           'font-size:11px;text-transform:uppercase;letter-spacing:.08em}'
           ' .stats td{padding:9px 14px 9px 0;border-top:1px solid var(--cardline)}'
           ' .stats .dim{color:var(--ink2)}'
           ' .tag{font-size:11px;border-radius:var(--r-pill);padding:2px 10px;border:1px solid var(--cardline)}'
           ' .tag-live{color:var(--good);border-color:color-mix(in srgb,var(--good) 40%,transparent)}'
           ' .tag-arch{color:var(--ink2)}'
           ' .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:var(--sp-3);'
           'margin:18px 0 22px}'
           ' .kpi{background:var(--card);border:1px solid var(--cardline);border-radius:var(--r-lg);'
           'padding:16px 18px;box-shadow:var(--shadow)}'
           ' .kv{font-size:26px;font-weight:650;letter-spacing:-.01em}'
           ' .kl{font-size:11px;color:var(--ink2);text-transform:uppercase;letter-spacing:.1em;'
           'margin-top:4px}')
    return (f'<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Статистика фабрики</title>'
            f'<style>{CSS}{DOC_CSS}{css}</style></head>'
            f'<body><div id="app"><div class="top"><h1>&#128202; Статистика фабрики</h1>'
            f'<a class="back" href="/" target="_top" style="margin-left:auto">&larr; на дашборд</a></div>'
            f'{"".join(head)}<article class="doc card wide" style="max-width:none">'
            f'{"".join(body)}</article></div></body></html>')


def render_plan(task, doc='plan'):
    """Страница документа с воротами: план (plan) или отчёт приёмки (report)."""
    path = f'{STATE_DIR}/t{task}.{doc}.md'
    md = None
    try:
        with open(path, encoding='utf-8') as f:
            md = f.read()
    except OSError:
        if doc == 'plan':
            md = plan_from_journal(task)
    if md is None:
        md = 'План ещё не готов — конвейер работает (обнови страницу позже).'
    pf = parse_env_file(f'{STATE_DIR}/t{task}.pipeline')
    gname = {'plan': 'plan', 'diag': 'cause'}.get(doc, 'accept')
    gkey = {'plan': 'GATE_PLAN', 'diag': 'GATE_CAUSE'}.get(doc, 'GATE_ACCEPT')
    what = {'plan': 'план', 'diag': 'причина и план фикса'}.get(doc, 'результат')
    gate = pf.get(gkey, 'pending')
    if gate == 'waiting':
        ok_lbl = {'plan': 'Утвердить', 'diag': 'Причина верна — чиним'}.get(doc, 'Принять')
        buttons = (f'<div class="gatebar"><b>Ворота: {what} ждёт твоего решения</b>'
                   f'<button class="gbtn ok" onclick="gate(\'{task}\',\'approve\')">&#10003; {ok_lbl}</button>'
                   f'<button class="gbtn no" onclick="gate(\'{task}\',\'reject\')">&#10007; Отклонить</button></div>')
    else:
        label = {'approved': '&#10003; принят', 'rejected': '&#10007; отклонён'}.get(gate, gate)
        cls = {'approved': 'done', 'rejected': 'rej'}.get(gate, '')
        via = ' (из браузера)' if pf.get(gkey + '_VIA') == 'browser' else ''
        buttons = f'<div class="gatebar sub gate-{cls}">Статус: {label}{via}</div>'
    gate_js = ('<script>function gate(t,d){var c="";'
               # Отклонение без замечаний бесполезно: конвейер вернёт работу в сборку, а агент
               # не узнает, что чинить, и переделает то же самое (инцидент #8060).
               'if(d==="reject"){c=prompt("Что не так? Агент переделает по этим замечаниям:");'
               'if(c===null)return;c=c.trim();'
               'if(c.length<5){alert("Без замечаний отклонять нельзя: агент не поймёт, что исправлять.");return;}}'
               f'fetch("/api/gate/t"+t+"/{gname}/"+d,{{method:"POST",body:c}}).then(function(){{return fetch("/api/run/t"+t,{{method:"POST"}});}}).then(function(){{location.reload();}});}}'
               '</script>')
    title = {'plan': 'План задачи', 'diag': 'Диагностика'}.get(doc, 'Приёмка задачи')
    return (f'<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>{title} t{task}</title>'
            f'<style>{CSS}{DOC_CSS}'
            '.gatebar{display:flex;align-items:center;gap:14px;margin-top:12px;padding:12px 16px;'
            'border:1px solid var(--serious);border-radius:var(--r-md);background:#f0a13c14}'
            '.gbtn{border-radius:var(--r-md);cursor:pointer;padding:6px 18px;font:13px ui-monospace,monospace;background:none}'
            '.gate-done{border-color:color-mix(in srgb,var(--good) 50%,transparent) !important;color:var(--good)}.gate-rej{border-color:color-mix(in srgb,var(--critical) 50%,transparent) !important;color:var(--critical)}.gbtn.ok{border:1px solid var(--good);color:var(--good)}.gbtn.ok:hover{box-shadow:0 0 10px #39d35344}'
            '.gbtn.no{border:1px solid var(--critical);color:var(--critical)}.gbtn.no:hover{box-shadow:0 0 10px #f0554d44}'
            f'</style>{gate_js}</head>'
            f'<body><div id="app"><div class="top"><h1>&#128203; {title} #{html.escape(task)}</h1></div>'
            f'<div class="sub back"><a href="/" target="_top">&larr; на дашборд</a></div>'
            f'{buttons}'
            f'<article class="doc card wide">{md2html(md)}</article></div></body></html>')


DOC_CSS = """
.doc { max-width:900px; margin-top:14px; padding:28px 38px;
  font:14.5px/1.7 system-ui,-apple-system,'Segoe UI',sans-serif; }
.doc h2 { all:unset; display:block; font-size:21px; font-weight:700; color:var(--ink);
  margin:4px 0 14px; letter-spacing:0; text-transform:none; }
.doc h3 { font-size:16px; font-weight:700; color:var(--good); margin:26px 0 8px;
  padding-bottom:5px; border-bottom:1px solid var(--cardline); }
.doc h4 { font-size:14px; font-weight:700; color:var(--serious); margin:18px 0 6px; }
.doc h2::before, .doc h3::before, .doc h4::before { content:none; }
.doc p { margin:0 0 10px; color:var(--ink); }
.doc ul, .doc ol { margin:0 0 12px; padding-left:24px; }
.doc li { margin:4px 0; }
.doc b { color:#fff; }
.doc code { font:12.5px ui-monospace,monospace; background:#1a241d; color:#8fe3ae;
  padding:1px 6px; border-radius:var(--r-sm); border:1px solid #24382c; }
"""


# Фавикон: мини-конвейер (зелёный done -> оранжевый агент -> бирюзовый код -> янтарные ворота)
FAVICON = ('<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,'
           "%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E"
           "%3Crect width='64' height='64' rx='14' fill='%230d130f'/%3E"
           "%3Cpath d='M19 22h8M37 22h8M50 28L37 39' stroke='%232c6e49' stroke-width='3' fill='none'/%3E"
           "%3Ccircle cx='14' cy='22' r='5' fill='%2339d353'/%3E"
           "%3Ccircle cx='32' cy='22' r='5' fill='none' stroke='%23e8833a' stroke-width='3'/%3E"
           "%3Ccircle cx='50' cy='22' r='5' fill='none' stroke='%232fc5c5' stroke-width='3'/%3E"
           "%3Ccircle cx='32' cy='44' r='6' fill='%2320160a' stroke='%23e3c341' stroke-width='3'/%3E"
           '%3C/svg%3E">')


class Handler(http.server.BaseHTTPRequestHandler):
    def handle_one_request(self):
        """Клиент часто уходит раньше ответа: страница обновляется каждые 5 с, и при F5
        браузер обрывает предыдущий запрос. Это не ошибка сервера — гасим шум в журнале
        (иначе на каждую перезагрузку падает трейсбек, а в консоли браузера — ERR_EMPTY_RESPONSE)."""
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def log_message(self, fmt, *args):
        pass          # штатные строки доступа journald только засоряют

    def do_POST(self):
        g = re.match(r'^/api/gate/t(\d+)/(plan|accept|cause)/(approve|reject)$', self.path)
        if g:
            task, gate, decision = g.group(1), g.group(2), g.group(3)
            pf_path = f'{STATE_DIR}/t{task}.pipeline'
            key = {'plan': 'GATE_PLAN', 'accept': 'GATE_ACCEPT', 'cause': 'GATE_CAUSE'}[gate]
            if os.path.exists(pf_path):
                with open(pf_path, encoding='utf-8') as f:
                    lines = [l for l in f.read().splitlines()
                             if not l.startswith((key + '=', key + '_VIA=', key + '_AT='))]
                val = 'approved' if decision == 'approve' else 'rejected'
                lines.append(f'{key}={val}')
                lines.append(f'{key}_VIA=browser')
                lines.append(f'{key}_AT={time.strftime("%Y-%m-%d %H:%M:%S")}')
                ln = int(self.headers.get('Content-Length') or 0)
                comment = self.rfile.read(ln).decode('utf-8', 'replace').strip() if ln else ''
                if comment:
                    lines.append(f'{key}_COMMENT={comment[:500]}')
                with open(pf_path, 'w', encoding='utf-8') as f:
                    f.write('\n'.join(lines) + '\n')
                body = b'{"ok": true}'
            else:
                body = b'{"ok": false}'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        # Ручной перевод статуса этапа из окна этапа. Значение проверяем по закрытому списку:
        # неизвестная строка в реестре для движка = «этап без статуса», и он погонит его заново.
        s = re.match(r'^/api/stage/(\d+)/([a-z0-9_]+)/([a-z]+)$', self.path)
        if s:
            task, nid, val = s.group(1), s.group(2), s.group(3)
            pf = parse_env_file(f'{STATE_DIR}/t{task}.pipeline')
            meta = profile_graph_meta(pf.get('PROFILE', ''), pf.get('ROUTE', ''))
            key = meta['keys'].get(nid, nid.upper())
            if val not in dict(STAGE_VALUES):
                ok, msg = False, f'недопустимое значение: {val}'
            else:
                ok, msg = pipeline_set(task, key, val)
            body = json.dumps({'ok': ok, 'key': key, 'value': val, 'msg': msg},
                              ensure_ascii=False).encode('utf-8')
            self.send_response(200 if ok else 400)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body))); self.end_headers()
            self.wfile.write(body); return
        ac = re.match(r'^/api/act/(\d+)/([a-z0-9_]+)/([a-z_]+)$', self.path)
        if ac:
            # Кнопка-действие из окна этапа: «снять демо», «пропустить демо», «начать этап».
            # Вся честность (что реально запустится) — в stage_action, здесь только транспорт.
            ok, msg, started = stage_action(ac.group(1), ac.group(2), ac.group(3))
            body = json.dumps({'ok': ok, 'msg': msg, 'started': started},
                              ensure_ascii=False).encode('utf-8')
            self.send_response(200 if ok else 400)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body))); self.end_headers()
            self.wfile.write(body); return
        sd = re.match(r'^/api/sandbox/t(\d+)/down$', self.path)
        if sd:
            # Снос песочницы по кнопке человека. Ответ отдаём сразу: процесс сноса живёт
            # своей жизнью (см. sandbox_down), UI на нём не висит.
            ok, msg = sandbox_down(sd.group(1))
            body = json.dumps({'ok': ok, 'msg': msg}, ensure_ascii=False).encode('utf-8')
            self.send_response(200 if ok else 400)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body))); self.end_headers()
            self.wfile.write(body); return
        rn = re.match(r'^/api/run/t(\d+)$', self.path)
        if rn:
            # Ручной запуск/продолжение конвейера (по решению пользователя — не авто).
            # Требует открытого окружения (VS Code/терминал) — тут просто дёргаем скрипт.
            # Тот же предохранитель, что у кнопок этапа: пока демон жив, «Продолжить» —
            # это заявка на второй процесс. Сам bin/factory её отобьёт, но человеку в ответ
            # прилетало бодрое «● запущен», и он считал, что что-то произошло.
            _t = rn.group(1)
            _pid, _alive, _mins = daemon_state(_t, parse_env_file(f'{STATE_DIR}/t{_t}.pipeline'))
            if _alive:
                body = json.dumps({'ok': False, 'msg': f'конвейер уже работает: демон жив '
                                                       f'(pid {_pid}, {_mins} мин)'},
                                  ensure_ascii=False).encode('utf-8')
            else:
                body = json.dumps({'ok': True, 'msg': factory_resume(_t)},
                                  ensure_ascii=False).encode('utf-8')
            self.send_response(200); self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body); return
        m = re.match(r'^/api/timer/t(\d+)/(start|pause)$', self.path)
        if not m:
            self.send_response(404); self.end_headers(); return
        task, action = m.group(1), m.group(2)
        d = b24_timer(action, task) or {}
        _timer_cache.pop(task, None)  # сбросить кэш — следующий рендер возьмёт свежее
        body = json.dumps(d).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        demo = re.match(r'^/demo/(t\d+)/([\w.-]+\.(?:mp4|webm))$', self.path)
        if demo:
            fp = os.path.join(STATE_DIR, 'demo', demo.group(1), demo.group(2))
            if os.path.isfile(fp):
                with open(fp, 'rb') as fh:
                    data = fh.read()
                self.send_response(200)
                self.send_header('Content-Type', 'video/mp4' if fp.endswith('.mp4') else 'video/webm')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            else:
                self.send_response(404)
                self.end_headers()
            return
        shot = re.match(r'^/shots/(t\d+)/([\w.-]+\.png)$', self.path)
        if shot:
            fp = os.path.join(STATE_DIR, 'shots', shot.group(1), shot.group(2))
            if os.path.isfile(fp):
                with open(fp, 'rb') as fh:
                    data = fh.read()
                self.send_response(200)
                self.send_header('Content-Type', 'image/png')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            else:
                self.send_response(404)
                self.end_headers()
            return
        a = re.match(r'^/activity/t(\d+)$', self.path)
        m = re.match(r'^/plan/t(\d+)$', self.path)
        r = re.match(r'^/report/t(\d+)$', self.path)
        ti = re.match(r'^/task/t(\d+)$', self.path)
        dg = re.match(r'^/diag/t(\d+)$', self.path)
        sg = re.match(r'^/stage/t(\d+)/([a-z0-9_]+)$', self.path)
        if sg:
            page = render_stage(sg.group(1), sg.group(2))
            body = page.encode('utf-8')
            self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body); return
        if dg:
            page = render_plan(dg.group(1), doc='diag')
            body = page.encode('utf-8')
            self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body); return
        if self.path == '/routes':
            page = render_routes()
            body = page.encode('utf-8')
            self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body); return
        if self.path == '/tasks':
            page = render_tasks()
            body = page.encode('utf-8')
            self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body); return
        if self.path == '/stats':
            page = render_stats()
            body = page.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if a:
            page = render_activity(a.group(1))
        elif m:
            page = render_plan(m.group(1))
        elif r:
            page = render_plan(r.group(1), doc='report')
        elif ti:
            page = render_task_info(ti.group(1))
        else:
            page = render()
        page = page.replace('</title>', '</title>' + FAVICON, 1)
        body = page.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    import threading
    _load_info_cache()   # названия из прошлого запуска — видны сразу, без ожидания сети
    _load_stats_cache()
    threading.Thread(target=b24_refresher, daemon=True).start()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8070
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print(f'Дашборд фабрики: http://localhost:{port}')
    srv.serve_forever()
