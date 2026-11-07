import type { DraftNode } from '../../../../shared/pipeline/routeDefinition.ts';
import type { RouteEditorInfo } from '../../../../shared/pipeline/routesEditorContracts.ts';
import { stagePromptLimitExceeded } from '../../../../shared/pipeline/routeStageWizardContracts.ts';
import type {
  StageRoleAnswers, StageRoleId, StageRoleTemplate,
} from '../../../../shared/pipeline/routeStageWizardContracts.ts';
import type { RouteCommandIssue } from './routeCommands.ts';

export type WizardCapabilities = RouteEditorInfo['capabilities'];

export interface PreparedStageRole {
  roleId: StageRoleId;
  answers: StageRoleAnswers;
  nodes: DraftNode[];
  prompts: Record<string, string>;
  issues: RouteCommandIssue[];
  companion?: DraftNode;
}

/**
 * Согласует ответы образца с реально объявленными командами профиля.
 * Мастер и подготовка узла используют одни права, без скрытого выбора при сохранении.
 */
export function normalizeStageRoleAnswers(
  template: StageRoleTemplate, answers: StageRoleAnswers, capabilities: WizardCapabilities,
): StageRoleAnswers {
  const normalized = { ...template.defaults, ...answers };

  if (template.id === 'command' || template.id === 'review') {
    const commands = capabilities.commands.filter((command) => command.filesystem.length);
    const preferred = template.id === 'review'
      ? commands.find((command) => command.id === 'recheck' && command.filesystem.includes('state-only'))
        ?? commands.find((command) => command.filesystem.includes('state-only'))
      : commands.find((command) => command.id === 'verify');
    const command = commands.find((item) => item.id === normalized.commandId) ?? preferred ?? commands[0];

    normalized.commandId = command?.id;

    if (template.id === 'command') {
      if (!command?.filesystem.includes(normalized.filesystem ?? '')) {
        normalized.filesystem = command?.filesystem.includes('state-only')
          ? 'state-only' : command?.filesystem[0];
      }

      normalized.failure ??= 'return';
      normalized.browser = false;
      normalized.services = false;
    }
  }

  return normalized;
}

/**
 * Строит допустимые id и runKey из объявления команды, сохраняя сам commandId.
 * Дефис заменяется подчёркиванием; начальная цифра требует префикса в пределах длины id.
 */
export function stageCommandIdentity(commandId: string): { id: string; runKey: string } {
  const normalized = commandId.replaceAll('-', '_');
  const id = (/^[a-z]/.test(normalized) ? normalized : `command_${normalized}`).slice(0, 41);

  return { id, runKey: id.toUpperCase() };
}

/**
 * Превращает ответы в исполняемые права и отдельный блок инструкции.
 * Исходные блоки образца копируются без изменений; пользовательский текст не сокращается.
 */
export function prepareStageRole(
  template: StageRoleTemplate, answers: StageRoleAnswers, capabilities: WizardCapabilities,
): PreparedStageRole {
  answers = normalizeStageRoleAnswers(template, answers, capabilities);

  const roleId = template.id;
  const result: PreparedStageRole = {
    roleId,
    answers: { ...answers },
    nodes: [],
    prompts: { ...template.prompts },
    issues: [],
    ...(template.companion?.node ? { companion: structuredClone(template.companion.node) } : {}),
  };
  const issue = (code: string) => result.issues.push({ code, message: code });
  const node: DraftNode = template.node ? structuredClone(template.node) : {
    id: 'custom',
    executor: 'agent',
    phase: 'main',
    runKey: 'CUSTOM',
    emits: [],
    prompt: { blocks: [], requiredContext: ['task'] },
  };

  result.nodes.push(node);

  if (roleId === 'human') {
    return result;
  }

  if (roleId === 'review' && !capabilities.commands.length) {
    issue('recheck_unavailable');
  }

  node.fanout = {
    mode: 'single',
    maxExecutors: 1,
    degrade: 'forbid',
  };
  node.retry = {
    noResult: node.executor === 'command' ? 0 : 1,
    productFailure: 0,
    providerFailure: {
      attempts: node.executor === 'command' ? 0 : 1,
      strategy: node.executor === 'command' ? 'none' : 'runner-failover',
    },
  };
  node.policy = {
    filesystem: answers.filesystem ?? 'state-only',
    browser: answers.browser ? 'allow' : 'forbid',
    timeoutClass: answers.browser ? 'browser' : 'standard',
    budgetClass: 'standard',
  };

  if (node.executor === 'command') {
    const command = capabilities.commands.find((item) => item.id === answers.commandId);

    if (!command || !command.filesystem.length) {
      issue('command_unavailable');
    } else {
      node.commandId = command.id;
      Object.assign(node, stageCommandIdentity(command.id));
      node.policy.filesystem = answers.filesystem!;
    }

    node.policy.browser = 'forbid';

    return result;
  }

  if (answers.failure === 'self-fix' && answers.filesystem !== 'workspace-write') {
    issue('self_fix_readonly');
  }
  if (!capabilities.filesystem.includes(node.policy.filesystem)) {
    issue('filesystem_unavailable');
  }
  if (roleId === 'custom') {
    if (!answers.description?.trim()) {
      issue('description_required');
    }

    result.prompts['prompts/custom.md'] = answers.description ?? '';
    node.prompt = { blocks: [{ file: 'prompts/custom.md' }], requiredContext: ['task'] };
    node.description = (answers.description ?? '').slice(0, 500);
  }

  const prompt = node.prompt!;

  prompt.requiredContext = prompt.requiredContext.filter((section) => section !== 'services');

  if (answers.services || answers.browser) {
    prompt.requiredContext.push('services');
  }

  const file = `prompts/${roleId}.answers.md`;

  result.prompts[file] = [
    'Настройки этого этапа имеют приоритет над разрешающими фразами образца.',
    `Файловая политика: ${node.policy.filesystem}. Браузер: ${node.policy.browser}.`,
    `Стенд: ${Boolean(answers.services || answers.browser)}.`,
    `При проблеме: ${answers.failure ?? 'ask'}. Автор: ${answers.returnTargetId || 'человек'}.`,
    'Мелкие исправления выполняются внутри запуска; повторы по продуктовой ошибке запрещены.',
    'Проблемы человека и окружения всегда передаются человеку.',
  ].join('\n');
  prompt.blocks.push({ file });

  if (stagePromptLimitExceeded(result.prompts)) {
    issue('prompt_limit_exceeded');
  }

  return result;
}
