// Сервис настроек VPN-ворот: читает и пишет машинный .env общим писателем envFile.ts.
// Сами ворота исполняются ДО старта сервера (deploy/require-vpn.sh в ExecStartPre юнита
// и в окне-владельце), поэтому запись не применяют к окружению живого процесса:
// новая конфигурация действует после перезапуска, а read() отдаёт и сохранённое
// значение, и то, с которым текущий процесс уже работает.
import { EnvFileError, readEnvFile, updateEnvFile } from './envFile.ts';
import type { VpnGateView } from '../../../shared/runtime/vpnGateContracts.ts';

// Имена переменных совпадают с deploy/require-vpn.sh и server/src/lib/mobile/vpn.ts.
export const VPN_GATE_REQUIRE_KEY = 'GRIGDESK_REQUIRE_VPN';
export const VPN_GATE_IFACE_KEY = 'GRIGDESK_VPN_IFACE';
export const VPN_GATE_PROBE_KEY = 'GRIGDESK_VPN_PROBE';

// Умолчание скрипта ворот; дублируется здесь для подсказки в интерфейсе.
export const VPN_GATE_PROBE_DEFAULT = '1.1.1.1';

// Ограничения повторяют проверки скрипта: имя интерфейса из выдачи маршрута и sysfs.
const IFACE_RE = /^[A-Za-z0-9_.:+-]{1,15}$/;
// Адрес пробы: IPv4, IPv6 (с зоной через %) или имя хоста без пробелов и схем.
const PROBE_RE = /^[A-Za-z0-9.:%-]{1,64}$/;

export type VpnGateInputErrorCode = 'vpn_gate_iface_invalid' | 'vpn_gate_probe_invalid';

// Ошибка входа называет поле, но не значение: ответ уходит в окно браузера.
export class VpnGateInputError extends Error {
  readonly code: VpnGateInputErrorCode;

  constructor(code: VpnGateInputErrorCode, message: string) {
    super(message);
    this.name = 'VpnGateInputError';
    this.code = code;
  }
}

export interface VpnGateInput {
  requireVpn: boolean;
  iface: string;
  probe: string;
}

export interface VpnGateServiceOptions {
  // Путь к машинному .env; без него читается только окружение процесса, запись невозможна.
  envPath: string | undefined;
  // Окружение, с которым процесс стартовал; по умолчанию — process.env.
  env?: NodeJS.ProcessEnv;
}

/**
 * Значение флага ворот из строки .env или окружения: набор значений тот же, что в скрипте.
 * Нераспознанная строка — null: скрипт на ней отказывает в запуске, интерфейсу важно
 * лишь показать это как «не совпадает с сохранённым».
 */
export function parseVpnGateRequire(raw: string | undefined): boolean | null {
  if (raw === undefined) {
    return null;
  }

  if (['1', 'true', 'yes'].includes(raw)) {
    return true;
  }

  return ['0', 'false', 'no'].includes(raw) ? false : null;
}

/**
 * Эффективное значение флага с текущим умолчанием «ворота выключены».
 * null (ключ не задан) и нераспознанная строка трактуются как выключенные:
 * включёнными ворота бывают только явной единицей.
 */
function effectiveRequire(raw: string | undefined): boolean {
  return parseVpnGateRequire(raw) ?? false;
}

/**
 * Снимок одного источника значений: файла .env или окружения процесса.
 */
function snapshotOf(source: Record<string, string | undefined>): VpnGateView['active'] {
  return {
    requireVpn: effectiveRequire(source[VPN_GATE_REQUIRE_KEY]),
    iface: source[VPN_GATE_IFACE_KEY] ?? '',
    probe: source[VPN_GATE_PROBE_KEY] ?? '',
  };
}

/**
 * Проверяет поля, которые пишет интерфейс: имя интерфейса и адрес пробы обязаны
 * проходить те же ограничения, что и внутри скрипта ворот.
 */
function validateInput(input: VpnGateInput): void {
  if (input.iface !== '' && !IFACE_RE.test(input.iface)) {
    throw new VpnGateInputError(
      'vpn_gate_iface_invalid',
      'Имя интерфейса VPN: до 15 символов латиницы, цифр и . _ : + -',
    );
  }

  if (input.probe !== '' && !PROBE_RE.test(input.probe)) {
    throw new VpnGateInputError(
      'vpn_gate_probe_invalid',
      'Адрес пробы: IPv4/IPv6 или имя хоста без пробелов, до 64 символов',
    );
  }
}

/**
 * Читает машинный .env и окружение процесса и собирает вид настроек ворот.
 * Отсутствующий .env — штатное состояние: все ключи не заданы, ворота выключены.
 */
export class VpnGateService {
  private readonly envPath: string | undefined;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: VpnGateServiceOptions) {
    this.envPath = options.envPath;
    this.env = options.env ?? process.env;
  }

  /**
   * Вид настроек: сохранённая конфигурация, действующие значения и признак того,
   * что сохранённое ещё не применено перезапуском.
   */
  async read(): Promise<VpnGateView> {
    const file = this.envPath ? await readEnvFile(this.envPath) : {};
    const configured = snapshotOf(file);
    const active = snapshotOf(this.env);

    return {
      ...configured,
      defaults: { probe: VPN_GATE_PROBE_DEFAULT },
      restartRequired: configured.requireVpn !== active.requireVpn
        || configured.iface !== active.iface
        || configured.probe !== active.probe,
      active,
    };
  }

  /**
   * Пишет все три ключа точечной правкой .env: флаг всегда явным 0/1, интерфейс и проба
   * удаляются из файла пустым значением. Возвращает вид после записи.
   */
  async write(input: VpnGateInput): Promise<VpnGateView> {
    validateInput(input);

    if (!this.envPath) {
      throw new EnvFileError('env_file_not_regular', 'Путь к машинному .env неизвестен.');
    }

    await updateEnvFile(this.envPath, {
      [VPN_GATE_REQUIRE_KEY]: input.requireVpn ? '1' : '0',
      [VPN_GATE_IFACE_KEY]: input.iface || null,
      [VPN_GATE_PROBE_KEY]: input.probe || null,
    });

    return this.read();
  }
}
