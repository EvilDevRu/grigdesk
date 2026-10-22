interface RewindQuestion {
  id: string;
  summary: string;
  anchor?: string;
}

/**
 * Указание агенту, уезжающее вместе с возвратом конвейера на узел.
 *
 * Ответы нумеруются вопросами узла и повторяют его же формулировку: агент читает
 * указание в промпте захода и должен видеть, на какой из СВОИХ вопросов ему ответили.
 * Пустой ответ пропускается — незаполненное поле означает «вопрос остаётся открытым»,
 * а не пустую строку в задании; номер при этом сохраняется тот, что человек видел в
 * форме, иначе сдвиг уцелевших ответов сообщил бы агенту, что закрыт первый вопрос,
 * тогда как открытым остался именно он.
 *
 * Общая для модалки узла и отдельного разбора арбитра: две копии склейки разошлись бы
 * на первой же правке, а собирают они один и тот же текст для одного эндпоинта.
 */
export function buildRewindNote(
  questions: RewindQuestion[] | null | undefined,
  answers: Record<string, unknown> | null | undefined,
  free: unknown,
): string {
  const answered = (questions || [])
    .map((question, index) => ({
      question,
      index,
      text: String(answers?.[question.id] || '').trim(),
    }))
    .filter((row) => row.text);

  const tail = String(free || '').trim();

  if (!answered.length) {
    return tail;
  }

  const block = answered
    .map(({ question, index, text }) => `${index + 1}. ${question.summary}\n   Ответ: ${text}`)
    .join('\n\n');
  const head = `Ответы на вопросы узла:\n\n${block}`;

  return tail ? `${head}\n\n${tail}` : head;
}

/**
 * Вопросы узла для формы ответа: только БЛОКИРУЮЩИЕ находки его вердикта.
 *
 * Отложенная находка — замечание на будущее, а не вопрос к человеку: поля под неё
 * сделали бы форму длиннее самого решения. Машинный `id` находки сохраняется, потому
 * что именно им ответ адресуется обратно её автору.
 */
export function rewindQuestionsOf(verdict: {
  findings?: Array<Partial<RewindQuestion> & { severity?: string }>;
} | null | undefined): RewindQuestion[] {
  const findings = verdict?.findings;

  if (!Array.isArray(findings)) {
    return [];
  }

  return findings
    .filter((finding) => finding.severity === 'blocking' && finding.summary)
    .map((finding, index) => ({
      id: finding.id || `q${index}`,
      summary: finding.summary!,
      anchor: finding.anchor || '',
    }));
}
