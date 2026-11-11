// Общедоступная форма настроек VPN-ворот для сервера и веб-интерфейса.
// Ворота исполняются до старта сервера (deploy/require-vpn.sh в ExecStartPre и окно),
// поэтому UI показывает и сохранённую конфигурацию, и ту, с которой процесс уже работает.
export interface VpnGateView {
  // Сохранённое значение флага: false — умолчание и явное отключение, true — ворота включены.
  requireVpn: boolean;
  // Явный интерфейс туннеля; пустая строка — автоматическое определение по маршруту.
  iface: string;
  // Адрес пробы маршрута; пустая строка — умолчание скрипта (см. defaultProbe).
  probe: string;
  // Умолчания скрипта ворот для подсказок в интерфейсе.
  defaults: { probe: string };
  // Конфигурация отличается от той, с которой текущий процесс стартовал: нужен перезапуск.
  restartRequired: boolean;
  // Значения, действующие с момента старта текущего процесса сервера.
  active: {
    requireVpn: boolean;
    iface: string;
    probe: string;
  };
}

/**
 * Проверяет ответ API ворот: неизвестная или неполная форма не попадает в интерфейс,
 * а превращается в понятную ошибку чтения настроек.
 */
export function decodeVpnGateView(raw: unknown): VpnGateView {
  const value = raw as VpnGateView | null;

  if (!value || typeof value !== 'object'
      || typeof value.requireVpn !== 'boolean'
      || typeof value.iface !== 'string'
      || typeof value.probe !== 'string'
      || !value.defaults || typeof value.defaults.probe !== 'string'
      || typeof value.restartRequired !== 'boolean'
      || !value.active || typeof value.active.requireVpn !== 'boolean'
      || typeof value.active.iface !== 'string'
      || typeof value.active.probe !== 'string') {
    throw new TypeError('VPN-ворота: неожиданный ответ сервера.');
  }

  return {
    requireVpn: value.requireVpn,
    iface: value.iface,
    probe: value.probe,
    defaults: { probe: value.defaults.probe },
    restartRequired: value.restartRequired,
    active: { ...value.active },
  };
}
