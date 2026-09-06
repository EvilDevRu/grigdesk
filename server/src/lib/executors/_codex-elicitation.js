import { validateStructuredAnswers } from '../chat/structured-answers.js';

const MAX_TEXT = 4_000;
const MAX_FIELDS = 50;
const MAX_OPTIONS = 100;

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function shortText(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';

  return (text || fallback).slice(0, MAX_TEXT);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * MCP разрешает только строковые варианты, но поддерживает три wire-формы:
 * enum, enum + enumNames и oneOf/anyOf с отдельными подписями.
 */
function optionsFrom(schema, multiple) {
  const source = multiple ? schema.items : schema;
  if (!plainObject(source)) return null;

  const titled = Array.isArray(source.anyOf)
    ? source.anyOf
    : (Array.isArray(source.oneOf) ? source.oneOf : null);
  if (titled) {
    if (!titled.length || titled.length > MAX_OPTIONS) return null;
    const options = titled.map((option) => {
      if (!plainObject(option) || typeof option.const !== 'string'
        || option.const.length > MAX_TEXT) return null;
      return {
        value: option.const,
        label: shortText(option.title, option.const),
      };
    });

    return options.every(Boolean) ? options : null;
  }

  if (!Array.isArray(source.enum)) return [];
  if (!source.enum.length || source.enum.length > MAX_OPTIONS) return null;
  const labels = Array.isArray(source.enumNames) ? source.enumNames : [];
  const options = source.enum.map((value, index) => {
    if (typeof value !== 'string' || value.length > MAX_TEXT) return null;
    return {
      value,
      label: shortText(labels[index], value),
    };
  });

  return options.every(Boolean) ? options : null;
}

function normalizedDefault(schema, inputType, options) {
  if (!Object.hasOwn(schema, 'default')) return undefined;
  const value = schema.default;

  if (inputType === 'text') {
    return typeof value === 'string' ? value.slice(0, MAX_TEXT) : undefined;
  }
  if (inputType === 'number' || inputType === 'integer') return finiteNumber(value);
  if (inputType === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (inputType === 'choice') {
    return typeof value === 'string' && options.some((option) => option.value === value)
      ? value
      : undefined;
  }
  if (inputType === 'multi-choice' && Array.isArray(value)) {
    const allowed = new Set(options.map((option) => option.value));
    const selected = value.filter((entry) => typeof entry === 'string' && allowed.has(entry));
    return selected.length === value.length ? selected : undefined;
  }
  return undefined;
}

/**
 * Превращает одну primitive-схему MCP в provider-neutral вопрос. В UI уезжают
 * только поддержанные примитивы и ограничения, а исходный произвольный JSON — нет.
 */
function normalizeField(name, schema, required) {
  if (typeof name !== 'string' || !name || name.length > 200) return null;
  if (!plainObject(schema) || typeof schema.type !== 'string') return null;

  const multiple = schema.type === 'array';
  const options = optionsFrom(schema, multiple);
  if (options === null) return null;

  let inputType;
  if (multiple) {
    if (!options.length) return null;
    inputType = 'multi-choice';
  } else if (options.length) {
    inputType = 'choice';
  } else if (schema.type === 'string') {
    inputType = 'text';
  } else if (schema.type === 'number' || schema.type === 'integer') {
    inputType = schema.type;
  } else if (schema.type === 'boolean') {
    inputType = 'boolean';
  } else {
    return null;
  }

  const title = shortText(schema.title, name);
  const field = {
    key: name,
    header: title,
    question: title,
    hint: shortText(schema.description),
    inputType,
    required,
    multiSelect: inputType === 'multi-choice',
    allowFreeText: inputType === 'text' || inputType === 'number' || inputType === 'integer',
    ...(options.length ? { options } : {}),
  };
  const value = normalizedDefault(schema, inputType, options);
  if (value !== undefined) field.default = value;

  if (inputType === 'text') {
    const minLength = nonNegativeInteger(schema.minLength);
    const maxLength = nonNegativeInteger(schema.maxLength);
    if (minLength !== undefined) field.minLength = minLength;
    if (maxLength !== undefined) field.maxLength = maxLength;
    if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) return null;
    if (['email', 'uri', 'date', 'date-time'].includes(schema.format)) {
      field.format = schema.format;
    }
  } else if (inputType === 'number' || inputType === 'integer') {
    const minimum = finiteNumber(schema.minimum);
    const maximum = finiteNumber(schema.maximum);
    if (minimum !== undefined) field.minimum = minimum;
    if (maximum !== undefined) field.maximum = maximum;
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) return null;
  } else if (inputType === 'multi-choice') {
    const minItems = nonNegativeInteger(schema.minItems);
    const maxItems = nonNegativeInteger(schema.maxItems);
    if (minItems !== undefined) field.minItems = minItems;
    if (maxItems !== undefined) field.maxItems = maxItems;
    if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) return null;
  }

  return field;
}

function safeExternalUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_TEXT) return '';
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return '';
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback)
      ? parsed.href
      : '';
  } catch {
    return '';
  }
}

function persistActions(meta) {
  const values = Array.isArray(meta?.persist) ? meta.persist : [meta?.persist];
  const advertised = new Set(values.filter((value) => value === 'session' || value === 'always'));
  return [
    'accept',
    ...(advertised.has('session') ? ['accept_session'] : []),
    ...(advertised.has('always') ? ['accept_always'] : []),
    'cancel',
  ];
}

function normalizedSuggestion(meta) {
  if (meta?.codex_approval_kind !== 'tool_suggestion') return null;
  if (!['connector', 'plugin'].includes(meta.tool_type)) return null;
  if (!['install', 'enable'].includes(meta.suggest_type)) return null;
  const suggestReason = shortText(meta.suggest_reason);
  const toolId = shortText(meta.tool_id);
  const toolName = shortText(meta.tool_name);
  if (!suggestReason || !toolId || !toolName) return null;
  const hasInstallUrl = Object.hasOwn(meta, 'install_url') && meta.install_url != null;
  const installUrl = hasInstallUrl ? safeExternalUrl(meta.install_url) : '';
  if (hasInstallUrl && !installUrl) return null;
  return {
    toolType: meta.tool_type,
    suggestType: meta.suggest_type,
    suggestReason,
    toolId,
    toolName,
    installUrl,
  };
}

function questionPresentation({ serverName, message, questions, actions, approvalKind = '' }) {
  return {
    elicitationMode: 'form',
    requiresExplicitUser: true,
    isQuestion: true,
    structured: true,
    structuredAnswers: true,
    acceptsText: true,
    source: `MCP · ${serverName}`,
    prompt: message,
    actions,
    approvalKind,
    questions,
  };
}

function externalPresentation({ serverName, message, url, approvalKind = '', suggestion = null }) {
  const isSuggestion = approvalKind === 'tool_suggestion';
  const description = suggestion?.suggestReason && suggestion.suggestReason !== message
    ? `${message}\n\n${suggestion.suggestReason}`
    : message;
  return {
    elicitationMode: isSuggestion ? 'suggestion' : 'url',
    requiresExplicitUser: true,
    approvalKind,
    suggestionHasUrl: isSuggestion,
    tool: suggestion
      ? `MCP · ${serverName} · ${suggestion.toolName}`
      : `MCP · ${serverName}`,
    acceptsComment: false,
    canRemember: false,
    actions: ['accept', 'decline'],
    input: {
      kind: 'external_url',
      description,
      url,
      link_label: isSuggestion
        ? (suggestion.suggestType === 'enable' ? 'Открыть настройки' : 'Открыть установку')
        : 'Открыть страницу',
      approve_label: 'Готово',
      reject_label: 'Отклонить',
    },
  };
}

/**
 * Нормализует server request Codex в общий контракт вмешательства человека.
 * URL не открывается автоматически, а произвольная схема не попадает во frontend.
 */
export function codexElicitationPresentation(params = {}) {
  if (!plainObject(params)) return null;

  // В Codex 0.150.1 variant развёрнут в params через serde(flatten). Вложенный
  // request принимаем только как терпимый fallback для сторонних прокси.
  const request = typeof params.mode === 'string'
    ? params
    : (plainObject(params.request) ? params.request : params);
  const serverName = shortText(params.serverName, 'MCP-сервер');
  const message = shortText(request.message, 'Сервис запрашивает дополнительные данные.');
  if (request.mode === 'url') {
    const url = safeExternalUrl(request.url);
    if (!url) return null;

    return externalPresentation({ serverName, message, url });
  }

  if (!['form', 'openai/form', 'openaiForm'].includes(request.mode)) return null;
  const meta = plainObject(request._meta)
    ? request._meta
    : (plainObject(request.meta) ? request.meta : null);
  const schema = request.requestedSchema;
  const emptySchema = schema == null || (plainObject(schema)
    && schema.type === 'object'
    && plainObject(schema.properties)
    && Object.keys(schema.properties).length === 0);
  const suggestion = normalizedSuggestion(meta);
  if (meta?.codex_approval_kind
    && !['mcp_tool_call', 'tool_suggestion'].includes(meta.codex_approval_kind)) return null;
  if (meta?.codex_approval_kind === 'tool_suggestion' && !suggestion) return null;
  if (!emptySchema && ['mcp_tool_call', 'tool_suggestion'].includes(meta?.codex_approval_kind)) {
    return null;
  }
  if (suggestion && emptySchema && suggestion.installUrl) {
    return externalPresentation({
      serverName,
      message,
      url: suggestion.installUrl,
      approvalKind: 'tool_suggestion',
      suggestion,
    });
  }
  if (emptySchema) {
    const approvalKind = suggestion
      ? 'tool_suggestion'
      : (meta?.codex_approval_kind === 'mcp_tool_call' ? 'mcp_tool_call' : 'message');
    const actions = approvalKind === 'mcp_tool_call'
      ? persistActions(meta)
      : ['accept', 'decline', 'cancel'];
    const prompt = suggestion && suggestion.suggestReason !== message
      ? `${message}\n\n${suggestion.toolName}: ${suggestion.suggestReason}`
      : message;
    return {
      ...questionPresentation({
        serverName,
        message: prompt,
        questions: [],
        actions,
        approvalKind,
      }),
      ...(suggestion ? { suggestion } : {}),
    };
  }

  if (!plainObject(schema) || schema.type !== 'object' || !plainObject(schema.properties)) {
    return null;
  }

  const properties = Object.entries(schema.properties);
  if (properties.length > MAX_FIELDS) return null;
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name) => typeof name === 'string')
      : [],
  );
  const questions = properties.map(([name, fieldSchema]) => (
    normalizeField(name, fieldSchema, required.has(name))
  ));
  if (!questions.every(Boolean)) return null;

  return questionPresentation({
    serverName,
    message,
    questions,
    actions: ['accept', 'decline', 'cancel'],
  });
}

function valueFromAnswer(question, answer) {
  if (!plainObject(answer)) return undefined;
  if (Object.hasOwn(answer, 'value')) return answer.value;
  if (question.inputType === 'text') return answer.text;
  if (question.inputType === 'multi-choice') return answer.selected;
  return Array.isArray(answer.selected) ? answer.selected[0] : undefined;
}

/**
 * Повторно проверяет ответ уже на серверной границе Codex: frontend помогает
 * заполнить форму, но не является доверенным валидатором MCP-содержимого.
 */
function formContent(presentation, decision) {
  const directContent = plainObject(decision?.content) ? decision.content : null;
  const answers = directContent
    ? Object.entries(directContent).map(([key, value]) => ({ key, value }))
    : (Array.isArray(decision?.answers) ? decision.answers.map((answer) => {
      const question = (presentation.questions || []).find((item) => item.key === answer?.key);
      return question ? { key: question.key, value: valueFromAnswer(question, answer) } : answer;
    }) : []);
  const validated = validateStructuredAnswers(presentation.questions || [], answers);
  if (!validated.ok) return null;
  return Object.fromEntries(validated.answers.map((answer) => [answer.key, answer.value]));
}

/** Ответ app-server всегда имеет точную MCP-форму accept/decline/cancel. */
export function codexElicitationResponse(presentation, decision = {}) {
  const cancelled = decision?.action === 'cancel'
    || decision?.outcome?.outcome === 'cancelled'
    || !!decision?.error;
  if (cancelled) return { action: 'cancel', content: null, _meta: null };

  if (presentation?.elicitationMode === 'url' || presentation?.suggestionHasUrl) {
    if (decision?.action === 'accept' || decision?.allow === true) {
      return { action: 'accept', content: null, _meta: null };
    }
    if (decision?.action === 'decline' || decision?.allow === false) {
      return { action: 'decline', content: null, _meta: null };
    }
    return {
      action: 'cancel',
      content: null,
      _meta: null,
    };
  }

  const action = typeof decision?.action === 'string' ? decision.action : '';
  if (action === 'decline' && presentation?.actions?.includes('decline')) {
    return { action: 'decline', content: null, _meta: null };
  }
  if (action === 'accept_session' || action === 'accept_always') {
    if (!presentation?.actions?.includes(action)) {
      return { action: 'cancel', content: null, _meta: null };
    }
    return {
      action: 'accept',
      content: null,
      _meta: { persist: action === 'accept_session' ? 'session' : 'always' },
    };
  }
  if (action !== 'accept' || !presentation?.actions?.includes('accept')) {
    return { action: 'cancel', content: null, _meta: null };
  }
  if (!(presentation?.questions || []).length) {
    return {
      action: 'accept',
      content: presentation?.approvalKind === 'tool_suggestion' ? {} : null,
      _meta: null,
    };
  }
  const content = formContent(presentation || {}, decision);
  return content
    ? { action: 'accept', content, _meta: null }
    : { action: 'cancel', content: null, _meta: null };
}
