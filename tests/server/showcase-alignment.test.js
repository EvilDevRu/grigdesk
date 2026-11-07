import assert from 'node:assert/strict';
import test from 'node:test';

import {
  alignSpeechTiming,
  normalizeMeasuredSpeechSpans,
  speechFixtureOf,
} from '../../server/src/lib/showcase/voice/alignment.ts';

test('словесные метки последовательно сопоставляют пунктуацию, ё/е и повторы', () => {
  const canonicalText = 'Ещё, ещё — откроем обзор.';
  const result = alignSpeechTiming({
    canonicalText,
    durationMs: 1_400,
    timing: {
      words: [
        { text: ' еще', startMs: 100, endMs: 300 },
        { text: 'ещё', startMs: 340, endMs: 520 },
        { text: 'откроем', startMs: 650, endMs: 930 },
        { text: 'обзор.', startMs: 960, endMs: 1_250 },
      ],
      segments: [{ text: 'Еще, ещё — откроем обзор.', startMs: 100, endMs: 1_250 }],
    },
  });

  assert.equal(result.quality, 'word-exact');
  assert.deepEqual(
    result.spans.map(({ from, to, precision }) => ({
      text: canonicalText.slice(from, to), precision,
    })),
    [
      { text: 'Ещё', precision: 'word' },
      { text: 'ещё', precision: 'word' },
      { text: 'откроем', precision: 'word' },
      { text: 'обзор', precision: 'word' },
    ],
  );
  assert.equal(result.phrases.length, 1);
});

// Модель пишет реплику одним предложением, и сентенциальных пауз в ней нет; паузу
// синтеза на запятой видно по измеренной тишине между словами — она безопасна для
// вставки. Знак без тишины и тишина без знака паузами не становятся.
test('пауза синтеза на знаке препинания внутри фразы становится безопасной паузой', () => {
  const canonicalText = 'Открываем окно, отмечаем десктоп и жмём: готово. Дальше.';
  const result = alignSpeechTiming({
    canonicalText,
    durationMs: 3_500,
    timing: {
      words: [
        { text: 'открываем', startMs: 0, endMs: 400 },
        { text: 'окно', startMs: 400, endMs: 700 },
        { text: 'отмечаем', startMs: 1_020, endMs: 1_400 },
        // Тишина без знака препинания — не пауза синтеза.
        { text: 'десктоп', startMs: 1_600, endMs: 1_900 },
        { text: 'и', startMs: 1_900, endMs: 1_980 },
        { text: 'жмём', startMs: 1_980, endMs: 2_200 },
        // Двоеточие с тишиной короче порога — тоже нет.
        { text: 'готово', startMs: 2_260, endMs: 2_600 },
        { text: 'дальше', startMs: 3_000, endMs: 3_400 },
      ],
      segments: null,
    },
  });

  assert.equal(result.quality, 'word-exact');
  assert.deepEqual(result.safePauses, [
    {
      id: 'clause-2',
      textAt: canonicalText.indexOf('окно') + 'окно'.length,
      atMs: 860,
      quietFromMs: 700,
      quietToMs: 1_020,
    },
    {
      id: 'pause-1',
      textAt: canonicalText.indexOf('готово') + 'готово'.length,
      atMs: 2_800,
      quietFromMs: 2_600,
      quietToMs: 3_000,
    },
  ]);
});

test('число словами не получает выдуманных словесных границ и понижает режим до фразы', () => {
  const canonicalText = 'В отчёте 2026 записей.';
  const result = alignSpeechTiming({
    canonicalText,
    durationMs: 2_000,
    timing: {
      words: [
        { text: 'в', startMs: 100, endMs: 180 },
        { text: 'отчете', startMs: 200, endMs: 500 },
        { text: 'две', startMs: 520, endMs: 700 },
        { text: 'тысячи', startMs: 710, endMs: 920 },
        { text: 'двадцать', startMs: 930, endMs: 1_150 },
        { text: 'шесть', startMs: 1_160, endMs: 1_300 },
        { text: 'записей', startMs: 1_330, endMs: 1_700 },
      ],
      segments: [{
        text: 'В отчёте две тысячи двадцать шесть записей.',
        startMs: 100,
        endMs: 1_700,
      }],
    },
  });

  assert.equal(result.quality, 'phrase');
  assert.equal(result.spans.length, 1);
  assert.equal(result.spans[0].precision, 'phrase');
  assert.equal(canonicalText.slice(result.spans[0].from, result.spans[0].to), 'В отчёте 2026 записей');
});

test('фразовые границы дают только подтверждённые паузы между законченными фразами', () => {
  const canonicalText = 'Откроем фильтр. Теперь виден результат!';
  const result = alignSpeechTiming({
    canonicalText,
    durationMs: 2_500,
    timing: {
      words: null,
      segments: [
        { text: 'Откроем фильтр.', startMs: 100, endMs: 800 },
        { text: 'Теперь виден результат!', startMs: 1_100, endMs: 2_200 },
      ],
    },
  });

  assert.equal(result.quality, 'phrase');
  assert.equal(result.phrases.length, 2);
  assert.deepEqual(result.safePauses, [{
    id: 'pause-1',
    textAt: canonicalText.indexOf('фильтр') + 'фильтр'.length,
    atMs: 950,
    quietFromMs: 800,
    quietToMs: 1_100,
  }]);
});

test('неоднозначная или отсутствующая расшифровка остаётся approximate без времён текста', () => {
  const unrelated = alignSpeechTiming({
    canonicalText: 'Открываем обзор.',
    durationMs: 1_000,
    timing: {
      segments: [{ text: 'Совсем другая реплика.', startMs: 50, endMs: 900 }],
    },
  });
  const missing = alignSpeechTiming({
    canonicalText: 'Открываем обзор.',
    durationMs: 1_000,
    timing: null,
  });

  for (const result of [unrelated, missing]) {
    assert.equal(result.quality, 'approximate');
    assert.deepEqual(result.spans, []);
    assert.deepEqual(result.phrases, []);
    assert.deepEqual(result.safePauses, []);
  }
});

test('измерения проверяются без сортировки и допускают только миллисекунду на конце', () => {
  assert.deepEqual(normalizeMeasuredSpeechSpans([
    { text: 'раз', startMs: 0, endMs: 400 },
    { text: 'два', startMs: 400, endMs: 1_001 },
  ], 1_000), [
    { text: 'раз', startMs: 0, endMs: 400 },
    { text: 'два', startMs: 400, endMs: 1_000 },
  ]);

  assert.equal(normalizeMeasuredSpeechSpans([
    { text: 'позже', startMs: 500, endMs: 700 },
    { text: 'раньше', startMs: 100, endMs: 300 },
  ], 1_000), null);
  assert.equal(normalizeMeasuredSpeechSpans([
    { text: 'долго', startMs: 100, endMs: 1_002 },
  ], 1_000), null);
});

test('PCM-профиль добавляется без изменения результата сопоставления', () => {
  const aligned = alignSpeechTiming({
    canonicalText: 'Готово.',
    durationMs: 500,
    timing: {
      words: [{ text: 'готово', startMs: 20, endMs: 450 }],
      segments: [{ text: 'Готово.', startMs: 20, endMs: 450 }],
    },
  });

  assert.deepEqual(speechFixtureOf(aligned, { sampleRate: 24_000, sampleCount: 12_000 }), {
    canonicalText: 'Готово.',
    durationMs: 500,
    sampleRate: 24_000,
    sampleCount: 12_000,
    quality: 'word-exact',
    spans: aligned.spans,
    phrases: aligned.phrases,
    safePauses: aligned.safePauses,
  });
});
