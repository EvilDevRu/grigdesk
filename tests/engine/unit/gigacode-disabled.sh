#!/usr/bin/env bash
# Временное отключение проверяется настоящим обнаружением shell-модулей.
# Сохранённый исходник не получает слот раннера и не запускает внешний CLI.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/runners/index.sh"

runner_registry_reset
runner_registry_load "$FACTORY_HOME/lib/runners"
assert_rc 0 "$?" 'Реестр остальных раннеров загружается'
runner_registry_has gigacode
assert_rc 1 "$?" 'GigaCode отсутствует в реестре конвейера'
[[ -f "$FACTORY_HOME/lib/runners/gigacode.sh.disabled" ]]
assert_rc 0 "$?" 'Исходник GigaCode сохранён для последующего возвращения'
[[ ! -e "$FACTORY_HOME/lib/runners/gigacode.sh" ]]
assert_rc 0 "$?" 'Автоматически загружаемого модуля GigaCode нет'

finish_tests
