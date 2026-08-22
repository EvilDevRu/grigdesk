// Проверяет настройки и безопасную браузерную озвучку ответов компаньона.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import {
  DEVICE_PREFS_KEY,
  readDevicePrefs,
} from '../../web/src/features/companion/device-prefs.js';
import { spokenText } from '../../web/src/features/companion/spoken-text.js';
import { createSpeechOutput } from '../../web/src/features/companion/speech-output.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    dump(key) { return values.get(key); },
  };
}

function fakeBrowser({ available = true } = {}) {
  const calls = [];
  const listeners = new Map();
  const voices = [
    { voiceURI: 'ru-main', lang: 'ru-RU', name: 'Русский' },
    { voiceURI: 'en-main', lang: 'en-US', name: 'English' },
  ];
  const synthesis = available ? {
    cancel() { calls.push(['cancel']); },
    speak(utterance) { calls.push(['speak', utterance]); },
    getVoices() { return voices; },
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
  } : null;
  class Utterance {
    constructor(text) { this.text = text; }
  }
  return { calls, listeners, synthesis, Utterance: available ? Utterance : null };
}

function fakeDocument() {
  const listeners = new Map();
  return {
    hidden: false,
    listeners,
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
  };
}

function fakeEventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    dispatch(name, event) { listeners.get(name)?.(event); },
  };
}

test('COMP-TTS-01: device prefs default off, strict schema и только device storage', () => {
  const storage = memoryStorage({
    [DEVICE_PREFS_KEY]: JSON.stringify({
      schema: 99, enabled: 'yes', ttsEnabled: true, ttsConsent: false,
      voiceURI: 42, rate: 99, volume: -3, token: 'secret',
    }),
  });
  assert.deepEqual(readDevicePrefs(storage), {
    schema: 1, enabled: true, ttsEnabled: true, ttsConsent: false,
    voiceURI: '', rate: 1.3, volume: 0,
  });
  assert.equal(readDevicePrefs(memoryStorage()).ttsEnabled, false);
});

test('COMP-SAY-01/02: formatter сохраняет plain и превращает Markdown в естественный текст', () => {
  assert.equal(spokenText('Готово. Можно продолжать.'), 'Готово. Можно продолжать.');
  assert.equal(spokenText('**Важно**\n\n- первый пункт\n- второй пункт'), 'Важно первый пункт второй пункт');
});

test('COMP-SAY-03/04/07: code, URL, paths, env, tokens, HTML и controls не произносятся', () => {
  const source = [
    'Ответ безопасен.',
    '`rm -rf /tmp/x`',
    '```sh\nTOKEN=never\necho secret\n```',
    'Ссылка https://evil.test/a и /home/user/private.',
    'Файлы (/home/user/inside.txt), "/home/user/quoted.env" и (C:\\Users\\me\\secret.txt).',
    'Внутри /home/user/a(b)c.txt и UNC "\\\\server\\share\\private.docx".',
    'API_KEY=abcdef A=topsecret token=shortsecret abcdef0123456789abcdef0123456789abcdef0123456789.',
    '<script>hidden secret</script>\u061C\u200E\u200F\u202E\u0007',
  ].join('\n');
  const out = spokenText(source);
  assert.match(out, /Ответ безопасен/);
  assert.doesNotMatch(out, /rm -rf|TOKEN|echo|https|evil|\/home|C:\\|inside|quoted|a\(b\)|server|share|private|API_KEY|topsecret|shortsecret|abcdef|hidden|secret|[\u061C\u200E\u200F\u202E]/u);
  assert.equal(spokenText('```js\nalert(1)\n```'), '');

  for (const sensitive of [
    '"/home/user/My Secret/file.txt"',
    '"C:\\Users\\me\\My Secret\\key.txt"',
    '"\\\\server\\share\\My Secret\\key.txt"',
    'TOKEN="very secret value"',
    "token='another secret value'",
    'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.signatureSECRET',
    'Bearer bearerSECRETvalue',
    'mailto:alice@example.com',
    'ftp://alice:password@example.com/private',
  ]) {
    const redacted = spokenText(`Готово. ${sensitive} Продолжаю.`);
    assert.doesNotMatch(redacted, /home|Users|server|share|Secret|secret|ABCDEF|eyJ|signature|bearer|alice|example/iu,
      `утечка sensitive fragment: ${sensitive}`);
  }
});

test('COMP-SAY-05/06: максимум 3 предложения и 480 code points, suffix ровно один', () => {
  const many = 'Первое. Второе! Третье? Четвёрто. Пятое.';
  const out = spokenText(many);
  assert.match(out, /^Первое\. Второе! Третье\?/);
  assert.equal((out.match(/Подробности оставил в чате\./g) || []).length, 1);
  assert.doesNotMatch(out, /Четвёрто/);

  const long = spokenText(`Начало ${'🧭'.repeat(700)}.`);
  assert.ok([...long.replace(/ Подробности оставил в чате\.$/, '')].length <= 480);
  assert.equal((long.match(/Подробности оставил в чате\./g) || []).length, 1);
  assert.doesNotMatch(long, /�/);
});

test('COMP-TTS-02/03/05/08/10: adapter fail-safe, cancel-before-speak и stale events', () => {
  const storage = memoryStorage({
    [DEVICE_PREFS_KEY]: JSON.stringify({
      schema: 1, enabled: true, ttsEnabled: true, ttsConsent: true,
      voiceURI: 'missing', rate: 9, volume: -2,
    }),
  });
  const browser = fakeBrowser();
  const documentRef = fakeDocument();
  const states = [];
  const output = createSpeechOutput({
    synthesis: browser.synthesis,
    Utterance: browser.Utterance,
    storage,
    documentRef,
    language: () => 'ru',
    onState: (state) => states.push(state.status),
  });

  assert.equal(output.speak({
    voiceTurnId: 'v1', chatId: 'c1', messageId: 'm1', role: 'assistant',
    speechSafe: true, text: 'Готово.',
  }), true);
  assert.deepEqual(browser.calls.slice(0, 2).map(([name]) => name), ['cancel', 'speak']);
  const first = browser.calls[1][1];
  assert.equal(first.voice.voiceURI, 'ru-main', 'missing voiceURI даёт language fallback');
  assert.equal(first.lang, 'ru-RU');
  assert.equal(first.rate, 1.3);
  assert.equal(first.volume, 0);

  output.updatePrefs({ rate: 1, volume: 1 });
  assert.equal(output.speak({
    voiceTurnId: 'v2', chatId: 'c1', messageId: 'm2', role: 'assistant',
    speechSafe: true, text: 'Новый ответ.',
  }), true);
  const second = browser.calls.at(-1)[1];
  first.onend();
  assert.equal(output.snapshot().status, 'speaking', 'stale onend не завершает новую речь');
  second.onend();
  assert.equal(output.snapshot().status, 'idle');
  assert.ok(states.includes('speaking'));

  const unavailable = createSpeechOutput({ storage: memoryStorage(), documentRef });
  assert.equal(unavailable.snapshot().available, false);
  assert.equal(unavailable.speak({
    voiceTurnId: 'x', chatId: 'c', messageId: 'm', role: 'assistant', speechSafe: true, text: 'x',
  }), false);
  const unavailableEnabled = unavailable.enable();
  assert.equal(unavailableEnabled.status, 'unavailable');
  assert.equal(unavailableEnabled.enabled, false, 'saved preference не изображает effective API');
  assert.equal(unavailableEnabled.prefs.ttsEnabled, true);
  assert.equal(unavailableEnabled.prefs.ttsConsent, true,
    'выбор сохраняется и применится, когда speechSynthesis станет доступен');
  output.dispose();
});

test('COMP-TTS-04/06/07/09/11/12: exact voice turn once; cancel gates и cleanup listener', async () => {
  const storage = memoryStorage();
  const browser = fakeBrowser();
  const documentRef = fakeDocument();
  const output = createSpeechOutput({
    synthesis: browser.synthesis, Utterance: browser.Utterance, storage, documentRef,
  });
  output.updatePrefs({ ttsEnabled: true, ttsConsent: true });
  const direct = {
    voiceTurnId: 'v1', chatId: 'c1', messageId: 'm1', role: 'assistant',
    speechSafe: true, text: 'Ответ.',
  };

  assert.equal(output.speak(direct), true);
  assert.equal(output.speak(direct), false, 'тот же local turn/message не говорится повторно');
  assert.equal(output.speak({ ...direct, messageId: 'note', role: 'note' }), false);
  assert.equal(output.speak({ ...direct, messageId: 'perm', kind: 'permission' }), false);
  assert.equal(output.speak({ ...direct, messageId: 'steps', steps: [{}] }), false);
  assert.equal(output.speak({ ...direct, messageId: 'missing-verdict', speechSafe: undefined }), false);

  const activeUtterance = browser.calls.findLast(([name]) => name === 'speak')[1];
  const cancelsBeforeHide = browser.calls.filter(([name]) => name === 'cancel').length;
  documentRef.hidden = true;
  documentRef.listeners.get('visibilitychange')();
  assert.equal(browser.calls.filter(([name]) => name === 'cancel').length, cancelsBeforeHide + 1,
    'visibilitychange немедленно отменяет уже идущую речь');
  activeUtterance.onend();
  assert.notEqual(output.snapshot().status, 'speaking', 'late onend скрытой речи не оживляет состояние');
  documentRef.hidden = false;
  output.setChat('c2');
  output.micStart();
  documentRef.hidden = true;
  assert.equal(output.speak({ ...direct, voiceTurnId: 'v2', messageId: 'm2' }), false);
  output.cancel('logout');
  output.disable();
  assert.equal(JSON.parse(storage.dump(DEVICE_PREFS_KEY)).ttsEnabled, false);
  assert.equal(storage.dump(DEVICE_PREFS_KEY).includes('Ответ'), false, 'текст ответа не пишется в storage');

  assert.equal(browser.listeners.has('voiceschanged'), true);
  assert.equal(documentRef.listeners.has('visibilitychange'), true);
  output.dispose();
  assert.equal(browser.listeners.has('voiceschanged'), false);
  assert.equal(documentRef.listeners.has('visibilitychange'), false);
  assert.ok(browser.calls.filter(([name]) => name === 'cancel').length >= 4);

  const adapterSource = await readFile(
    new URL('../../web/src/features/companion/speech-output.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(adapterSource, /\bfetch\s*\(|\bapi\s*\./u,
    'speech adapter не получает сетевой канал для текста ответа');
});

test('COMP-TTS-14: mute действует только в текущем окне и не выключает device preference', () => {
  const storage = memoryStorage();
  const browser = fakeBrowser();
  const output = createSpeechOutput({
    synthesis: browser.synthesis,
    Utterance: browser.Utterance,
    storage,
    documentRef: fakeDocument(),
  });
  output.enable();
  assert.equal(output.snapshot().muted, false);
  output.mute();
  assert.equal(output.snapshot().muted, true);
  assert.equal(output.snapshot().enabled, false);
  assert.equal(JSON.parse(storage.dump(DEVICE_PREFS_KEY)).ttsEnabled, true,
    'window mute не переписывает durable device preference');
  output.unmute();
  assert.equal(output.snapshot().muted, false);
  assert.equal(output.snapshot().enabled, true);
  output.dispose();
});

test('COMP-TTS-16: device prefs из другого окна синхронно гасят TTS и companion', () => {
  const storage = memoryStorage();
  const browser = fakeBrowser();
  const eventTarget = fakeEventTarget();
  const snapshots = [];
  const output = createSpeechOutput({
    synthesis: browser.synthesis,
    Utterance: browser.Utterance,
    storage,
    documentRef: fakeDocument(),
    eventTarget,
    onState: (snapshot) => snapshots.push(snapshot),
  });
  output.enable();
  assert.equal(output.speak({
    voiceTurnId: 'cross-tab', chatId: 'c1', messageId: 'm1', role: 'assistant',
    speechSafe: true, text: 'Не продолжать после device opt-out.',
  }), true);
  const cancels = browser.calls.filter(([name]) => name === 'cancel').length;
  storage.setItem(DEVICE_PREFS_KEY, JSON.stringify({
    ...output.snapshot().prefs,
    enabled: false,
    ttsEnabled: false,
  }));
  eventTarget.dispatch('storage', { key: DEVICE_PREFS_KEY });

  assert.equal(output.snapshot().prefs.enabled, false);
  assert.equal(output.snapshot().prefs.ttsEnabled, false);
  assert.equal(output.snapshot().enabled, false);
  assert.equal(browser.calls.filter(([name]) => name === 'cancel').length, cancels + 1);
  assert.equal(snapshots.at(-1).prefs.enabled, false,
    'CompanionHost получает новый device-enabled через общий output snapshot');
  assert.equal(eventTarget.listeners.has('storage'), true);
  output.dispose();
  assert.equal(eventTarget.listeners.has('storage'), false);
});

test('COMP-TTS-13: normalizer start/text/think разрешают final, action/error steps fail-closed', () => {
  const storage = memoryStorage();
  const browser = fakeBrowser();
  const output = createSpeechOutput({
    synthesis: browser.synthesis,
    Utterance: browser.Utterance,
    storage,
    documentRef: fakeDocument(),
  });
  output.updatePrefs({ ttsEnabled: true, ttsConsent: true });
  const direct = {
    voiceTurnId: 'normalizer-turn',
    chatId: 'companion-7',
    role: 'assistant',
    speechSafe: true,
    text: 'Готово. `npm test` и https://internal.example/log оставил в чате.',
  };

  assert.equal(output.speak({
    ...direct,
    messageId: 'benign-text',
    steps: [
      { k: 'start', model: 'codex-test', mode: 'plan', cwd: '/workspace' },
      { k: 'text', text: 'Готово.' },
    ],
  }), true, 'реальная normalizer-лента start/text не глушит обычный ответ');
  const spokenTextStep = browser.calls.at(-1)[1].text;
  assert.match(spokenTextStep, /Готово/);
  assert.doesNotMatch(spokenTextStep, /npm test|https|internal\.example/,
    'code/URL по-прежнему режет formatter, а не step policy');

  assert.equal(output.speak({
    ...direct,
    messageId: 'benign-think',
    steps: [
      { k: 'start', model: 'claude-test' },
      { k: 'think', text: 'Проверяю контракт.' },
    ],
  }), true, 'start/think тоже не являются действием');

  const unsafe = [
    [{ k: 'start' }, { k: 'tool', name: 'Bash', title: 'npm test' }],
    [{ k: 'start' }, { k: 'res', ok: true, text: 'ok' }],
    [{ k: 'note', level: 'warn', text: 'сетевая ошибка' }],
    [{ kind: 'permission', command: 'hidden' }],
    [{ kind: 'question', options: ['hidden'] }],
    [{ kind: 'error', text: 'hidden' }],
    [{ k: 'unknown' }],
    [{ k: 'text', kind: 'tool' }],
    [{}],
  ];
  unsafe.forEach((steps, index) => {
    assert.equal(output.speak({
      ...direct,
      voiceTurnId: `unsafe-turn-${index}`,
      messageId: `unsafe-${index}`,
      steps,
    }), false, `unsafe/unknown step ${index} должен блокировать TTS`);
  });
  assert.equal(browser.calls.filter(([name]) => name === 'speak').length, 2);

  assert.equal(output.speak({
    ...direct,
    voiceTurnId: 'trimmed-unsafe-turn',
    messageId: 'trimmed-unsafe',
    speechSafe: false,
    steps: Array.from({ length: 400 }, () => ({ k: 'text', text: 'хвост' })),
  }), false, 'monotonic server verdict блокирует раннее unsafe-событие после sliding tail');
  output.dispose();
});
