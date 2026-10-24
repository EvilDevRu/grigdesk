#!/usr/bin/env bash

# Lifecycle работает только с объявленной копией и собственной env-проекцией.
# Запуск и остановка серверов не входят в обязанности общего образца.
set -euo pipefail
sample_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec python3 -B "$sample_dir/workspace.py" up "$@"
