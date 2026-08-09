#!/usr/bin/env bash

_breaker_validate_id() {
  [[ "${1:-}" =~ ^[A-Za-z0-9._-]+$ ]]
}

_breaker_entry_id() {
  printf '%s|%s|%s' "$1" "$2" "$3" | sha256sum | awk '{print $1}'
}

_breaker_account_dir() {
  local provider=$1 fingerprint=$2
  printf '%s/runners/breakers/v1/%s/%s\n' "${STATE_DIR:?}" "$provider" "$fingerprint"
}

_breaker_entry_file() {
  local provider=$1 fingerprint=$2 scope=$3 family=$4 model=$5 dir id
  dir=$(_breaker_account_dir "$provider" "$fingerprint")
  id=$(_breaker_entry_id "$scope" "$family" "$model")
  printf '%s/%s.state\n' "$dir" "$id"
}

_breaker_get() {
  local file=$1 key=$2
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$file" 2>/dev/null
}

breaker_record() {
  local provider=$1 fingerprint=$2 scope=$3 family=$4 model=$5
  local detected_at=$6 limited_until=${7:-} evidence=${8:-}
  _breaker_validate_id "$provider" && _breaker_validate_id "$fingerprint" || return 2
  case "$scope" in
    provider) family=""; model="" ;;
    family) _breaker_validate_id "$family" || return 2; model="" ;;
    model) _breaker_validate_id "$family" && _breaker_validate_id "$model" || return 2 ;;
    *) return 2 ;;
  esac
  [[ "$detected_at" =~ ^[0-9]+$ ]] || return 2
  [[ -z "$limited_until" || "$limited_until" =~ ^[0-9]+$ ]] || return 2
  # Срок приходит из чужого вывода (машинное поле claude, разобранная фраза
  # codex), поэтому он ограничивается ЗДЕСЬ, в единственном месте записи, а не
  # в каждом раннере. Промах разбора на год выключил бы живой ИИ насовсем:
  # чинится такое только удалением файла руками. Срок в прошлом — тот же промах,
  # а не «лимит уже кончился»: отказ провайдера случился только что.
  if [[ -n "$limited_until" ]]; then
    local ceiling
    ceiling=$(_breaker_max_until "$detected_at")
    (( limited_until > detected_at )) || limited_until=""
    if [[ -n "$limited_until" ]] && (( limited_until > ceiling )); then
      limited_until=$ceiling
    fi
  fi
  evidence=${evidence//$'\n'/ }
  local dir file lock_fd tmp
  dir=$(_breaker_account_dir "$provider" "$fingerprint")
  mkdir -p "$dir"
  exec {lock_fd}>"$dir/.lock"
  flock "$lock_fd" || return 1
  file=$(_breaker_entry_file "$provider" "$fingerprint" "$scope" "$family" "$model")
  tmp=$(mktemp "$dir/.breaker.XXXXXX")
  {
    printf 'SCHEMA=1\nSTATUS=limited\nSCOPE=%s\nFAMILY=%s\nMODEL=%s\n' \
      "$scope" "$family" "$model"
    printf 'DETECTED_AT=%s\nLIMITED_UNTIL=%s\nEVIDENCE=%s\n' \
      "$detected_at" "$limited_until" "$evidence"
  } >"$tmp"
  mv -f -- "$tmp" "$file"
  flock -u "$lock_fd"
  eval "exec ${lock_fd}>&-"
}

# Предохранитель НИКОГДА не бывает бессрочным. Адаптеры провайдеров время сброса
# лимита не сообщают (DISPATCH_LIMIT_UNTIL никто не заполняет), поэтому пустое
# LIMITED_UNTIL раньше означало «навсегда»: провайдер выпадал из цепочки до ручного
# удаления файла. Claude мог уже отлежать лимит, а конвейер продолжал ходить в мёртвый
# резерв. Без известного срока держим предохранитель
# ограниченный cooldown от момента обнаружения.
_breaker_default_cooldown() {
  local value=${FACTORY_BREAKER_COOLDOWN_S:-900}
  [[ "$value" =~ ^[0-9]+$ ]] || value=900
  printf '%s\n' "$value"
}

# Потолок срока: сутки от обнаружения. Дольше не бывает ни одно окно лимита
# подписки, а всё, что дальше, — это ошибка разбора чужого текста.
_breaker_max_until() {
  local detected=$1 span=${FACTORY_BREAKER_MAX_S:-86400}
  [[ "$span" =~ ^[0-9]+$ ]] || span=86400
  printf '%s\n' "$(( detected + span ))"
}

_breaker_entry_active() {
  local file=$1 now=$2 until status detected cooldown
  [[ -f "$file" ]] || return 1
  status=$(_breaker_get "$file" STATUS)
  until=$(_breaker_get "$file" LIMITED_UNTIL)
  [[ "$status" == limited ]] || return 1
  if [[ -z "$until" || "$until" == 0 ]]; then
    detected=$(_breaker_get "$file" DETECTED_AT)
    [[ "$detected" =~ ^[0-9]+$ ]] || return 1
    cooldown=$(_breaker_default_cooldown)
    until=$(( detected + cooldown ))
  fi
  if [[ "$now" -gt "$until" ]]; then
    return 1
  fi
}

breaker_match() {
  local provider=$1 fingerprint=$2 family=$3 model=$4 now=$5
  local scope file
  BREAKER_MATCH_SCOPE=""
  BREAKER_MATCH_FILE=""
  for scope in provider family model; do
    case "$scope" in
      provider) file=$(_breaker_entry_file "$provider" "$fingerprint" provider "" "") ;;
      family) file=$(_breaker_entry_file "$provider" "$fingerprint" family "$family" "") ;;
      model) file=$(_breaker_entry_file "$provider" "$fingerprint" model "$family" "$model") ;;
    esac
    if _breaker_entry_active "$file" "$now"; then
      BREAKER_MATCH_SCOPE=$scope
      BREAKER_MATCH_FILE=$file
      return 0
    fi
  done
  return 1
}

breaker_clear() {
  local provider=$1 fingerprint=$2 scope=$3 family=$4 model=$5
  local dir file lock_fd
  dir=$(_breaker_account_dir "$provider" "$fingerprint")
  [[ -d "$dir" ]] || return 0
  exec {lock_fd}>"$dir/.lock"
  flock "$lock_fd" || return 1
  file=$(_breaker_entry_file "$provider" "$fingerprint" "$scope" "$family" "$model")
  rm -f -- "$file"
  flock -u "$lock_fd"
  eval "exec ${lock_fd}>&-"
}
