const WORD_RE = /[\p{L}\p{N}]+/gu;
const RUSSIAN_RE = /^[а-я]+$/u;
const VOWELS = 'аеиоуыэюя';

const PERFECTIVE = [
  ['ившись', true], ['ывшись', false], ['ивши', true], ['ывши', false],
  ['ив', true], ['ыв', false], ['вшись', true], ['вши', true], ['в', true],
];
const REFLEXIVE = ['ся', 'сь'];
const ADJECTIVE = [
  'ими', 'ыми', 'его', 'ого', 'ему', 'ому', 'ее', 'ие', 'ые', 'ое', 'ей', 'ий', 'ый', 'ой',
  'ем', 'им', 'ым', 'ом', 'их', 'ых', 'ую', 'юю', 'ая', 'яя', 'ою', 'ею',
];
const PARTICIPLE = [
  ['ем', true], ['нн', false], ['вш', false], ['ющ', false], ['щ', false], ['ивш', false],
  ['ывш', false], ['ующ', false],
];
const VERB = [
  ['ила', false], ['ыла', false], ['ена', false], ['ейте', false], ['уйте', false],
  ['ите', false], ['или', false], ['ыли', false], ['ей', false], ['уй', false],
  ['ил', false], ['ыл', false], ['им', false], ['ым', false], ['ен', false],
  ['ило', false], ['ыло', false], ['ено', false], ['ят', false], ['ует', false],
  ['уют', false], ['ит', false], ['ыт', false], ['ены', false], ['ить', false],
  ['ыть', false], ['ишь', false], ['ую', false], ['ю', false], ['ла', true],
  ['на', true], ['ете', true], ['йте', true], ['ли', true], ['й', true],
  ['л', true], ['ем', true], ['н', true], ['ло', true], ['но', true],
  ['ет', true], ['ны', true], ['ть', true], ['ешь', true], ['нно', true],
];
const NOUN = [
  'иями', 'ями', 'ами', 'ией', 'иям', 'ием', 'иях', 'ев', 'ов', 'ие', 'ье', 'еи', 'ии',
  'й', 'ей', 'ой', 'ий', 'иям', 'ям', 'ием', 'ем', 'ам', 'ом', 'о', 'у', 'ах', 'иях',
  'ях', 'ы', 'ь', 'ию', 'ью', 'ю', 'ия', 'ья', 'я', 'а', 'евы', 'ова', 'е', 'и',
];

function rvIndex(word) {
  for (let index = 0; index < word.length; index += 1) {
    if (VOWELS.includes(word[index])) {
      return index + 1;
    }
  }
  return word.length;
}

function removeSuffix(word, rvStart, suffixes) {
  for (const entry of suffixes) {
    const [suffix, afterAYa] = Array.isArray(entry) ? entry : [entry, false];
    const start = word.length - suffix.length;
    if (start < rvStart || !word.endsWith(suffix)) {
      continue;
    }
    if (afterAYa && !['а', 'я'].includes(word[start - 1])) {
      continue;
    }
    return { word: word.slice(0, start), removed: true };
  }
  return { word, removed: false };
}

/**
 * Детерминированный вариант русского Porter stemmer работает одинаково при
 * индексировании и при сборке MATCH-запроса. Латиница и числа остаются как есть.
 */
export function stemWord(input) {
  let word = String(input || '').normalize('NFKC').toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
  if (!RUSSIAN_RE.test(word) || word.length < 3) {
    return word;
  }

  const rvStart = rvIndex(word);
  let result = removeSuffix(word, rvStart, PERFECTIVE);
  word = result.word;
  if (!result.removed) {
    word = removeSuffix(word, rvStart, REFLEXIVE).word;
    result = removeSuffix(word, rvStart, ADJECTIVE);
    word = result.word;
    if (result.removed) {
      word = removeSuffix(word, rvStart, PARTICIPLE).word;
    } else {
      result = removeSuffix(word, rvStart, VERB);
      word = result.removed ? result.word : removeSuffix(word, rvStart, NOUN).word;
    }
  }
  word = removeSuffix(word, rvStart, ['и']).word;
  word = word.replace(/ейше$/u, '').replace(/нн$/u, 'н');
  word = removeSuffix(word, rvStart, ['ь', 'й']).word;
  // Заимствованные существительные вроде «деплой/деплоя» после основного шага
  // могут различаться одной соединительной гласной; схлопываем её симметрично.
  if (word.length > 3 && VOWELS.includes(word.at(-1))) {
    word = word.slice(0, -1);
  }
  return word || String(input).toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
}

export function normalizedTokens(value) {
  const normalized = String(value || '').normalize('NFKC').toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
  return [...normalized.matchAll(WORD_RE)]
    .map((match) => stemWord(match[0]))
    .filter(Boolean);
}

export function normalizeForSearch(value) {
  return normalizedTokens(value).join(' ');
}

/** Находит первое морфологическое совпадение, сохраняя исходный текст и регистр. */
export function originalFragment(body, queryTokens, maxChars = 180) {
  const source = String(body || '');
  const wanted = new Set(queryTokens);
  let offset = 0;
  for (const match of source.matchAll(WORD_RE)) {
    if (wanted.has(stemWord(match[0]))) {
      offset = match.index || 0;
      break;
    }
  }
  const start = Math.max(0, offset - Math.floor(maxChars / 3));
  const end = Math.min(source.length, start + maxChars);
  return `${start > 0 ? '…' : ''}${source.slice(start, end)}${end < source.length ? '…' : ''}`;
}
