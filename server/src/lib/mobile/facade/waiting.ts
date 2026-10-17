import { recordOrEmpty } from '../../../../../shared/lib/objects.ts';

import type { MobileApp } from '../mobileServer.ts';
import { validateStructuredAnswers } from '../../chat/structuredAnswers.ts';
import { decodeContract } from '../contract.ts';
import type {
  Question,
  QuestionWaiting,
  WaitingAnswer,
  Permission,
  UnsupportedWaiting,
} from '../contract.ts';
import { MobileInputError } from '../errors.ts';
import { TextPages, count, paginate, resourceId, text, upstream } from './common.ts';
import type { FacadeDeps, Payload } from './common.ts';

/**
 * Типы и ограничения берутся из schema самого ожидания, а не из ответного POST телефона.
 * Неподдерживаемая форма остаётся видимой и не получает кнопку с угаданным действием.
 */
function questionsOf(value: Payload): Question[] {
  const source = Array.isArray(value.questions) ? value.questions : [];

  if (!source.length || source.length > 50) {
    throw new Error('unsupported_questions');
  }

  return source.map((raw, index) => {
    const question = recordOrEmpty(raw);
    const options = Array.isArray(question.options) ? question.options : [];
    const inputType = value.structured
      ? String(question.inputType)
      : question.multiSelect
        ? 'multi-choice'
        : options.length
          ? 'choice'
          : 'text';

    if (
      !['text', 'number', 'integer', 'boolean', 'choice', 'multi-choice'].includes(inputType) ||
      options.length > 100
    ) {
      throw new Error('unsupported_question_type');
    }

    const constraints: Payload = {};

    for (const key of [
      'format',
      'minimum',
      'maximum',
      'minLength',
      'maxLength',
      'minItems',
      'maxItems',
    ]) {
      if (question[key] !== undefined) {
        constraints[key] = question[key];
      }
    }

    const result = {
      id: String(question.key || question.id || `q${index}`),
      header: String(question.header || question.label || ''),
      question: String(question.question || question.title || question.label || ''),
      multiSelect: inputType === 'multi-choice',
      allowFreeText: value.structured
        ? inputType === 'text' || inputType === 'integer' || inputType === 'number'
        : question.allowFreeText !== false,
      inputType: inputType as Question['inputType'],
      required: question.required === true,
      options: options.map((rawOption, optionIndex) => {
        const option = recordOrEmpty(rawOption);

        return {
          id: String(option.id ?? option.value ?? `o${optionIndex}`),
          label: String(option.label || option.title || option.value || ''),
          description: String(option.description || ''),
        };
      }),
      constraints,
    };

    // Исходный текст не сокращается: неверный размер переводит всё ожидание в unsupported.
    // Пользователь продолжает с полной схемой через обычный Кокпит.
    if (
      result.question.length > 32768 ||
      result.header.length > 800 ||
      result.options.some((option) => option.label.length > 800 || option.description.length > 4000)
    ) {
      throw new Error('question_too_large');
    }

    return result;
  });
}

/**
 * Для плана показывается полный plan, для обычного инструмента — все аргументы в виде текста.
 * Ни один HTML или shell-фрагмент из input не исполняется адаптером и интерфейсом.
 */
function permissionText(item: Payload): string {
  const input = recordOrEmpty(item.input);

  return item.tool === 'ExitPlanMode' && typeof input.plan === 'string'
    ? input.plan
    : JSON.stringify(item.input ?? {}, null, 2);
}

/**
 * Один фасад обслуживает реальные legacy, direct и structured каналы общего pending.
 * Опоздавшее решение сравнивает version в chat module в том же синхронном шаге, что resolve.
 */
export function registerWaitingRoutes(app: MobileApp, deps: FacadeDeps) {
  const pages = new TextPages(deps.tokens);

  /**
   * Чтение возвращает только ожидания, доступные внутреннему токену основного сервера.
   * Session-only SSH/БД не получают обычного permission token даже в поддельном upstream DTO.
   */
  async function waiting() {
    const body = await upstream(deps, 'GET', '/api/chat/waiting');

    return (Array.isArray(body.waiting) ? body.waiting : []).map(recordOrEmpty);
  }

  /**
   * Исчезнувшее ожидание — уже разрешённое действие, а не повод повторить команду.
   * Поиск нужен только для перевода формы; окончательный CAS остаётся в общем chat owner.
   */
  async function find(pid: string) {
    const found = (await waiting()).find((item) => item.pid === pid);

    if (!found) {
      throw new MobileInputError('already_resolved', 'На этот запрос уже ответили.', 409);
    }

    return found;
  }

  app.get<{ Querystring: Payload }>('/api/mobile/v1/waiting', async (request) => {
    const source = await waiting();
    const items = source.map((item): Permission | QuestionWaiting | UnsupportedWaiting => {
      const pid = resourceId(item.pid);
      const chatId = typeof item.chatKey === 'string' && item.chatKey ? item.chatKey : null;
      const version = typeof item.version === 'string' ? item.version : '';

      if (['ssh', 'db'].includes(String(item.origin)) || !version) {
        return {
          pid,
          chatId,
          kind: 'unsupported',
          reason: 'Этот запрос доступен в обычном Кокпите.',
        };
      }
      if (Array.isArray(item.questions)) {
        try {
          const questions = questionsOf(item);
          const actions = item.structured
            ? Array.isArray(item.actions)
              ? item.actions
              : []
            : ['accept', 'cancel'];

          if (
            !actions.length ||
            actions.some((action) => !['accept', 'cancel', 'decline'].includes(String(action)))
          ) {
            throw new Error('unsupported_actions');
          }

          const result: QuestionWaiting = {
            pid,
            chatId,
            kind: 'question',
            prompt: String(item.prompt || ''),
            structured: item.structured === true,
            actions: actions as QuestionWaiting['actions'],
            questions,
            actionToken: null,
          };

          if (
            Buffer.byteLength(JSON.stringify(result)) > 512 * 1024 ||
            result.prompt.length > 32768
          ) {
            throw new Error('questions_too_large');
          }

          return result;
        } catch {
          return {
            pid,
            chatId,
            kind: 'unsupported',
            reason: 'Форма вопроса требует обычного Кокпита.',
          };
        }
      }

      const page = pages.preview(permissionText(item));

      return {
        pid,
        chatId,
        kind: 'permission',
        tool: text(item.tool, 200),
        summary: text(
          item.tool === 'ExitPlanMode' ? 'Подтвердить план' : `Разрешить ${item.tool}`,
          800,
        ),
        details: page.text,
        acceptsComment: item.acceptsComment === true,
        canRemember: false,
        contentRevision: page.contentRevision,
        hasMore: page.hasMore,
        nextOffset: page.nextOffset,
        actionToken: page.readToken,
      };
    });
    const page = paginate(items, request.query, 48);

    for (const item of page.items) {
      const original = source.find((value) => value.pid === item.pid)!;

      if (item.kind === 'permission') {
        const read = pages.page(
          request.mobileDevice!.id,
          `waiting:${item.pid}`,
          permissionText(original),
          {},
          { version: original.version },
        );

        item.actionToken = read.readToken;
      } else if (item.kind === 'question') {
        item.actionToken = deps.tokens.issue(
          request.mobileDevice!.id,
          `waiting:${item.pid}`,
          'waiting',
          {
            version: original.version,
          },
        );
      }
    }

    return decodeContract('waiting', {
      items: page.items,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    });
  });

  app.get<{
    Params: { pid: string };
    Querystring: Payload;
  }>('/api/mobile/v1/waiting/:pid/details', async (request) => {
    const pid = resourceId(request.params.pid);
    const item = await find(pid);

    if (Array.isArray(item.questions) || ['ssh', 'db'].includes(String(item.origin))) {
      throw new MobileInputError('bad_request', 'У этого запроса нет страницы разрешения.');
    }

    return decodeContract(
      'details',
      pages.page(request.mobileDevice!.id, `waiting:${pid}`, permissionText(item), request.query, {
        version: item.version,
      }),
    );
  });

  app.post<{
    Params: { pid: string };
    Body: WaitingAnswer;
  }>('/api/mobile/v1/waiting/:pid', async (request) => {
    const pid = resourceId(request.params.pid);
    const item = await find(pid);
    const body = request.body;

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new MobileInputError('bad_request', 'Ответ должен быть объектом.');
    }

    const question = Array.isArray(item.questions);
    const snapshot = deps.tokens.take(
      request.mobileDevice!.id,
      `waiting:${pid}`,
      question ? 'waiting' : 'read',
      body?.actionToken,
    );

    if (snapshot.version !== item.version || ['ssh', 'db'].includes(String(item.origin))) {
      throw new MobileInputError('state_changed', 'Запрос изменился; перечитайте его.', 409);
    }

    const payload: Payload = {
      expectedVersion: snapshot.version,
      remember: false,
    };

    if (!question) {
      if (
        !['allow', 'deny'].includes(String(body.decision)) ||
        typeof (body.comment ?? '') !== 'string' ||
        String(body.comment || '').length > 4000
      ) {
        throw new MobileInputError(
          'bad_request',
          'Неверное решение или слишком длинное пояснение.',
        );
      }

      payload.allow = body.decision === 'allow';
      payload.comment = body.comment || '';
    } else {
      const questions = questionsOf(item);
      const actions = item.structured ? (item.actions as string[]) : ['accept', 'cancel'];

      if (
        !actions.includes(String(body.action)) ||
        (body.answers !== undefined && !Array.isArray(body.answers)) ||
        (body.answers?.length ?? 0) > 50
      ) {
        throw new MobileInputError('bad_request', 'Этот ответ не поддерживается запросом.');
      }

      const answers = body.action === 'accept' ? (body.answers ?? []) : [];
      const seen = new Set<string>();

      payload.action = body.action;
      payload.answers = answers.map((answer) => {
        if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
          throw new MobileInputError('bad_request', 'Неверная форма ответа.');
        }

        const question = questions.find((candidate) => candidate.id === answer.questionId);

        if (
          !question ||
          seen.has(question.id) ||
          !Array.isArray(answer.optionIds ?? []) ||
          (answer.optionIds ?? []).some(
            (id) => !question.options.some((option) => option.id === id),
          ) ||
          new Set(answer.optionIds ?? []).size !== (answer.optionIds ?? []).length ||
          (!question.multiSelect && (answer.optionIds?.length ?? 0) > 1) ||
          (!question.allowFreeText && Boolean(answer.text)) ||
          (answer.text !== undefined &&
            (typeof answer.text !== 'string' || answer.text.length > 4000))
        ) {
          throw new MobileInputError('bad_request', 'Ответ не соответствует вопросу.');
        }

        seen.add(question.id);

        if (item.structured) {
          let value: unknown = answer.value;
          const original = recordOrEmpty((item.questions as unknown[])[questions.indexOf(question)]);
          const originalOptions = (Array.isArray(original.options) ? original.options : []).map(
            recordOrEmpty,
          );
          const selected = (answer.optionIds ?? []).map(
            (id) =>
              originalOptions[question.options.findIndex((option) => option.id === id)]?.value,
          );

          if (value === undefined) {
            value =
              question.inputType === 'multi-choice'
                ? selected
                : question.inputType === 'choice'
                  ? selected[0]
                  : ['number', 'integer'].includes(question.inputType)
                    ? Number(answer.text)
                    : answer.text;
          }

          return {
            key: question.id,
            value,
          };
        }

        return {
          header: question.header,
          question: question.question,
          selected: (answer.optionIds ?? []).map(
            (id) => question.options.find((option) => option.id === id)!.label,
          ),
          text: answer.text || '',
        };
      });

      if (item.structured && body.action === 'accept') {
        const checked = validateStructuredAnswers(item.questions, payload.answers);

        if (!checked.ok) {
          throw new MobileInputError('bad_request', checked.error);
        }

        payload.answers = checked.answers;
      }
    }

    try {
      return decodeContract(
        'waiting-result',
        await upstream(deps, 'POST', `/api/chat/permission/${pid}`, payload),
      );
    } catch (error) {
      if (error instanceof MobileInputError && error.code === 'upstream_404') {
        throw new MobileInputError('already_resolved', 'На этот запрос уже ответили.', 409);
      }
      if (error instanceof MobileInputError && error.code === 'upstream_409') {
        throw new MobileInputError('state_changed', 'Запрос изменился; перечитайте его.', 409);
      }

      throw error;
    }
  });
}
