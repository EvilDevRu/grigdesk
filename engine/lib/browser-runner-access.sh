#!/usr/bin/env bash

# Public runtime roots получаем до model spawn из закреплённого helper.
# Из readiness читается лишь каталог собственных evidence, а не общий artifacts root.
factory_browser_runner_roots() {
  FACTORY_BROWSER_CODEX_READ_DIRS=""
  [[ "${FACTORY_BROWSER_ENABLED:-0}" == 1 &&
     "${FACTORY_ROUTE_BROWSER_POLICY:-forbid}" == allow ]] || return 0
  [[ "${GRIGDESK_BROWSER_NODE:-}" =~ ^/[A-Za-z0-9_@+.,/=-]+$ &&
     -x "$GRIGDESK_BROWSER_NODE" &&
     "${GRIGDESK_BROWSER_HELPER:-}" =~ ^/[A-Za-z0-9_@+.,/=-]+$ &&
     -f "$GRIGDESK_BROWSER_HELPER" ]] || return 4
  local roots evidence directory
  roots=$("$GRIGDESK_BROWSER_NODE" "$GRIGDESK_BROWSER_HELPER" read-roots) || return 4
  evidence=$("$GRIGDESK_BROWSER_NODE" "$GRIGDESK_BROWSER_HELPER" evidence-root 2>/dev/null) || evidence=""
  [[ -z "$evidence" ]] || roots+=$'\n'"$evidence"
  while IFS= read -r directory; do
    [[ -n "$directory" ]] || continue
    [[ "$directory" =~ ^/[A-Za-z0-9_@+.,/=-]+$ && -d "$directory" &&
       ! -L "$directory" && "$(realpath -e -- "$directory")" == "$directory" ]] || return 4
    FACTORY_BROWSER_CODEX_READ_DIRS+=" $directory"
  done <<<"$roots"
}
