#!/usr/bin/env bash
set -euo pipefail

# Python-дашборд читает тот же generic env, что сервер GrigDesk: single-repo
# показывается без выдуманных BE/FE, а повреждённый REPO_* не падает в legacy.
python3 - "$FACTORY_HOME/lib/dashboard.py" <<'PY'
import importlib.util
import sys

spec = importlib.util.spec_from_file_location('factory_dashboard', sys.argv[1])
dashboard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dashboard)

print('1..4')

generic = dashboard.parse_sandbox_repositories({
    'REPO_COUNT': '1',
    'REPO_0_NAME': 'sample-repository',
    'REPO_0_WT': '/tmp/sample-worktree',
    'REPO_0_BRANCH': 'task/42',
    'BE_WT': '/tmp/must-not-win',
})
assert generic == {
    'kind': 'generic',
    'repos': [{
        'name': 'sample-repository',
        'path': '/tmp/sample-worktree',
        'branch': 'task/42',
    }],
}
print('ok 1 - single-repo generic сохраняет имя, путь и ветку')

legacy = dashboard.parse_sandbox_repositories({
    'BE_WT': '/tmp/be-worktree',
    'FE_WT': '/tmp/fe-worktree',
    'BE_BRANCH': 'task/42',
    'FE_BRANCH': 'task/42',
})
assert legacy['kind'] == 'legacy'
assert [repo['name'] for repo in legacy['repos']] == ['be', 'fe']
print('ok 2 - legacy BE/FE остаётся совместимым')

missing = dashboard.parse_sandbox_repositories({
    'REPO_COUNT': '1',
    'REPO_0_NAME': 'sample-repository',
    'REPO_0_WT': '/tmp/sample-worktree',
    'BE_WT': '/tmp/must-not-open',
})
assert missing == {'kind': 'invalid', 'repos': []}
print('ok 3 - неполный generic не откатывается к legacy')

extra = dashboard.parse_sandbox_repositories({
    'REPO_COUNT': '1',
    'REPO_0_NAME': 'sample-repository',
    'REPO_0_WT': '/tmp/sample-worktree',
    'REPO_0_BRANCH': 'task/42',
    'REPO_1_NAME': 'лишний',
})
assert extra == {'kind': 'invalid', 'repos': []}
print('ok 4 - лишний индекс generic отклоняется exact-парсером')
PY
