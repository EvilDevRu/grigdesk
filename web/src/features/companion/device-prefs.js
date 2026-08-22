// Хранит и нормализует локальные для устройства настройки голосового компаньона.
export const DEVICE_PREFS_KEY = 'cockpit-companion-device-v1';

export const DEFAULT_DEVICE_PREFS = Object.freeze({
  schema: 1,
  enabled: true,
  ttsEnabled: false,
  ttsConsent: false,
  voiceURI: '',
  rate: 1,
  volume: 1,
});

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

export function normalizeDevicePrefs(value) {
  const raw = value && typeof value === 'object' ? value : {};
  return {
    schema: 1,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_DEVICE_PREFS.enabled,
    ttsEnabled: typeof raw.ttsEnabled === 'boolean' ? raw.ttsEnabled : DEFAULT_DEVICE_PREFS.ttsEnabled,
    ttsConsent: typeof raw.ttsConsent === 'boolean' ? raw.ttsConsent : DEFAULT_DEVICE_PREFS.ttsConsent,
    voiceURI: typeof raw.voiceURI === 'string'
      ? Array.from(raw.voiceURI.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '')).slice(0, 256).join('')
      : '',
    rate: clamp(raw.rate, 0.7, 1.3, DEFAULT_DEVICE_PREFS.rate),
    volume: clamp(raw.volume, 0, 1, DEFAULT_DEVICE_PREFS.volume),
  };
}

export function readDevicePrefs(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem?.(DEVICE_PREFS_KEY);
    return normalizeDevicePrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_DEVICE_PREFS };
  }
}

export function writeDevicePrefs(storage, value) {
  const normalized = normalizeDevicePrefs(value);
  try { storage?.setItem?.(DEVICE_PREFS_KEY, JSON.stringify(normalized)); } catch { /* Хранилище устройства необязательно. */ }
  return normalized;
}

export function updateDevicePrefs(storage, current, patch) {
  return writeDevicePrefs(storage, { ...current, ...(patch || {}) });
}
