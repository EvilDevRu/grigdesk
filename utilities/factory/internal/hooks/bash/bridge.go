package bash

import _ "embed"

// Bridge хранит ABI вызова доверенных хуков внутри бинарника фабрики.
// Скрипт профиля остаётся входом из явно выбранной установки.
//
//go:embed bridge.sh
var Bridge string
