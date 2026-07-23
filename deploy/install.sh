#!/usr/bin/env bash
# Установщик кокпита на машину разработчика (host-native, per-machine).
# Ставит зависимости, собирает web, регистрирует и запускает systemd user-сервис.
# Идемпотентно: повторный прогон обновляет.
set -euo pipefail

COCKPIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="cockpit-server.service"

echo "→ Кокпит: $COCKPIT_DIR"
echo "→ node:   $NODE_BIN ($(node -v))"

echo "→ Зависимости сервера…"
( cd "$COCKPIT_DIR/server" && npm install --no-audit --no-fund )

echo "→ Зависимости web + сборка…"
( cd "$COCKPIT_DIR/web" && npm install --no-audit --no-fund && npm run build )

echo "→ systemd user-юнит…"
mkdir -p "$UNIT_DIR"
sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__COCKPIT_DIR__|$COCKPIT_DIR|g" \
  "$COCKPIT_DIR/deploy/$UNIT" > "$UNIT_DIR/$UNIT"

echo "→ CLI b24 в PATH…"
mkdir -p "$HOME/.local/bin"
ln -sf "$COCKPIT_DIR/bin/b24" "$HOME/.local/bin/b24"
case ":$PATH:" in *":$HOME/.local/bin:"*) : ;; *) echo "  ⚠ добавь ~/.local/bin в PATH" ;; esac

systemctl --user daemon-reload
systemctl --user enable --now "$UNIT"

echo "✓ Готово. Статус:"
systemctl --user --no-pager status "$UNIT" | head -n 6 || true
echo "  Логи:  journalctl --user -u $UNIT -f"
echo "  URL:   http://localhost:8140  (с планшета — через Tailscale: http://<ip>:8140)"
