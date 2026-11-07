import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { parseKeyboardLayout } from '../../shared/desktop/keyboardLayout.ts';
import type { KeyboardLayout } from '../../shared/desktop/keyboardLayout.ts';

const execute = promisify(execFile);

// XKB возвращает активную группу даже до первого ввода в поле. Python использует
// системную libX11 через ctypes: дополнительный модуль и native addon Electron не нужны.
export const X11_LAYOUT_QUERY = String.raw`
import ctypes as c
import json

class State(c.Structure):
    _fields_ = [
        ('group', c.c_ubyte), ('locked_group', c.c_ubyte),
        ('base_group', c.c_ushort), ('latched_group', c.c_ushort),
        ('mods', c.c_ubyte), ('base_mods', c.c_ubyte),
        ('latched_mods', c.c_ubyte), ('locked_mods', c.c_ubyte),
        ('compat_state', c.c_ubyte), ('grab_mods', c.c_ubyte),
        ('compat_grab_mods', c.c_ubyte), ('lookup_mods', c.c_ubyte),
        ('compat_lookup_mods', c.c_ubyte), ('ptr_buttons', c.c_ushort),
    ]

x = c.CDLL('libX11.so.6')
x.XOpenDisplay.argtypes = [c.c_char_p]
x.XOpenDisplay.restype = c.c_void_p
x.XDefaultRootWindow.argtypes = [c.c_void_p]
x.XDefaultRootWindow.restype = c.c_ulong
x.XInternAtom.argtypes = [c.c_void_p, c.c_char_p, c.c_int]
x.XInternAtom.restype = c.c_ulong
x.XkbGetState.argtypes = [c.c_void_p, c.c_uint, c.POINTER(State)]
x.XGetWindowProperty.argtypes = [
    c.c_void_p, c.c_ulong, c.c_ulong, c.c_long, c.c_long, c.c_int, c.c_ulong,
    c.POINTER(c.c_ulong), c.POINTER(c.c_int), c.POINTER(c.c_ulong),
    c.POINTER(c.c_ulong), c.POINTER(c.c_void_p),
]
x.XFree.argtypes = [c.c_void_p]
x.XCloseDisplay.argtypes = [c.c_void_p]
display = x.XOpenDisplay(None)
if not display:
    raise RuntimeError('display_unavailable')

data = c.c_void_p()
try:
    state = State()
    if x.XkbGetState(display, 0x0100, c.byref(state)) != 0:
        raise RuntimeError('keyboard_unavailable')
    atom = x.XInternAtom(display, b'_XKB_RULES_NAMES', True)
    if not atom:
        raise RuntimeError('layout_names_unavailable')
    actual, count, remaining = c.c_ulong(), c.c_ulong(), c.c_ulong()
    fmt = c.c_int()
    result = x.XGetWindowProperty(
        display, x.XDefaultRootWindow(display), atom, 0, 1024, False, 31,
        c.byref(actual), c.byref(fmt), c.byref(count), c.byref(remaining), c.byref(data),
    )
    if result != 0 or actual.value != 31 or fmt.value != 8 or remaining.value or not data:
        raise RuntimeError('layout_names_invalid')
    names = c.string_at(data, count.value).decode('utf-8').split('\0')
    layouts, variants = names[2].split(','), names[3].split(',')
    print(json.dumps({
        'code': layouts[state.group],
        'variant': variants[state.group] if state.group < len(variants) else '',
    }))
finally:
    if data:
        x.XFree(data)
    x.XCloseDisplay(display)
`;

interface KeyboardLayoutOptions {
  platform: string;
  env: NodeJS.ProcessEnv;
  query?: () => Promise<string>;
  now?: () => number;
}

/**
 * Читает клавиатуру машины окна, независимо от выбранного сервера GrigDesk.
 * Параллельные запросы объединяются; ошибки и неподдерживаемые сессии дают null.
 */
export function createKeyboardLayoutReader(
  options: KeyboardLayoutOptions,
): () => Promise<KeyboardLayout | null> {
  const supported = options.platform === 'linux' && !!options.env.DISPLAY
    && options.env.XDG_SESSION_TYPE !== 'wayland' && !options.env.WAYLAND_DISPLAY;
  const now = options.now ?? Date.now;
  const query = options.query ?? (async () => {
    const result = await execute('python3', ['-I', '-c', X11_LAYOUT_QUERY], {
      env: options.env,
      timeout: 1200,
      maxBuffer: 4096,
      windowsHide: true,
    });

    return result.stdout;
  });
  let pending: Promise<KeyboardLayout | null> | null = null;
  let cached: KeyboardLayout | null = null;
  let expires = 0;

  return async () => {
    if (!supported) {
      return null;
    }

    if (pending) {
      return pending;
    }

    if (now() < expires) {
      return cached;
    }

    pending = Promise.resolve().then(query)
      .then((output) => parseKeyboardLayout(JSON.parse(output))).catch(() => null);

    try {
      cached = await pending;
      expires = now() + (cached ? 250 : 5000);

      return cached;
    } finally {
      pending = null;
    }
  };
}
