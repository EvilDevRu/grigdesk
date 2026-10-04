const markdown = '## Проверка интерфейса\n\n' +
  'Выполнен **шаг** с [результатом](https://example.test/result).\n\n' +
  '- Проверены `параметры`.\n- Сохранено описание.\n\n';

/**
 * Одинаковый seed задаёт размер истории и последовательность границ каждого запуска.
 * Legacy-вариант содержит одинаковые ответы с разными телами шагов без устойчивых id.
 */
export function performanceData(legacy = false) {
  const now = Date.UTC(2026, 8, 1);
  const text = markdown.repeat(60).slice(0, 6000);
  const sessions = Array.from({
    length: 80
  }, (_, index) => ({
    id: `fixture-${index}`,
    title: `Искусственный разговор ${index}`,
    model: 'fixture-model',
    modelRef: {
      provider: 'fixture-provider',
      model: 'fixture-model'
    },
    workdir: {
      kind: 'cockpit'
    },
    revision: 1,
    schema: 2,
    surface: 'chats',
    draft: '',
    createdAt: now,
    updatedAt: now + 1000 * index,
    messages: [{
      role: 'assistant',
      text
    }],
  }));

  sessions[0].messages = Array.from({
    length: 50
  }, (_, turn) => {
    const runId = `old-run-${turn}`;
    const assistantMessageId = `old-reply-${turn}`;
    const steps = Array.from({
      length: 150
    }, (_, index) => ({
      k: index % 3 === 0 ? 'text' : index % 3 === 1 ? 'tool' : 'res',
      id: index % 3 === 0 ? `block-${turn}-${index}` : `tool-${turn}-${Math.floor(index / 3)}`,
      name: 'Bash',
      text: `Ход ${turn}, шаг ${index}. `.padEnd(1000, 'о'),
      at: now + turn * 10000 + index,
    }));
    const question = {
      role: 'user',
      text: 'Проверь интерфейс',
      turnId: `old-turn-${turn}`
    };
    const final = {
      role: 'assistant',
      text: turn === 49 ? text + '\n\n```ts\nconst historical = 1;\n```\n\n' +
        '```js\nlet retained = true;\n```\n\n```mermaid\nflowchart TD\n A-->B\n```' : text,
      model: 'fixture-model',
      steps
    };

    if (legacy) {
      return [question, final];
    }

    return [question, {
      role: 'assistant',
      kind: 'assistant-block',
      text: 'Завершённый промежуточный блок',
      assistantMessageId: `block-${turn}-0`,
      runId,
      parentTurnId: question.turnId,
      sequence: 1,
      complete: true,
    }, {
      ...final,
      runId,
      parentTurnId: question.turnId,
      assistantMessageId,
      finalAssistantMessageId: assistantMessageId,
      sequence: 2,
    }];
  }).flat();
  sessions[0].messages.push({
    role: 'user',
    text: 'Продолжай',
    turnId: 'current-turn'
  });

  return {
    sessions,
    archived: [],
    activeId: 'fixture-0'
  };
}
