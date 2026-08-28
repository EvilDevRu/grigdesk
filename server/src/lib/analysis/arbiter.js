import { promises as fs } from 'node:fs';
import path from 'node:path';

import { resolveModelRef } from '../chat/model-ref.js';
import { supportsScopedWorkspace } from '../executors/index.js';
import { createWorkIpc } from '../executors/work-ipc.js';
import { createRepoHistoryTools } from './repo-history.js';

function parseReply(value) {
  const text = String(value || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Арбитр триажа проверяет только вопросы, на которые можно ответить фактами из кода.
 * Продуктовый выбор, приоритет и расширение границы принудительно остаются человеку.
 */
export class AnalysisArbiter {
  constructor({
    analyzer, pluginEnabled, pluginSettings, providerRegistry, executorFor, log,
  }) {
    this.analyzer = analyzer;
    this.pluginEnabled = pluginEnabled || (() => true);
    this.pluginSettings = pluginSettings || (() => ({}));
    this.providerRegistry = providerRegistry || (async () => ({}));
    this.executorFor = executorFor || (async () => null);
    this.log = log;
    this.locks = new Map();
  }

  async arbitrate(id, { automatic = false } = {}) {
    const taskId = String(id);
    const previous = this.locks.get(taskId) || Promise.resolve();
    const run = previous.then(() => this._arbitrate(taskId, { automatic }));
    const guarded = run.catch(() => {});
    this.locks.set(taskId, guarded);
    try {
      return await run;
    } finally {
      if (this.locks.get(taskId) === guarded) {
        this.locks.delete(taskId);
      }
    }
  }

  async _arbitrate(id, { automatic }) {
    if (!this.pluginEnabled('analysis')) {
      return { ok: false, error: 'plugin_disabled' };
    }
    const settings = this.pluginSettings('analysis') || {};
    if (automatic && settings.autoArbitrate !== true) {
      return { ok: true, outcome: 'auto_disabled', answered: 0 };
    }

    const detail = await this.analyzer.get(id);
    const handled = new Set(
      (await this.analyzer.readClarificationEntries(id)).map((entry) => entry.questionId),
    );
    const questions = (detail.analysis?.questions || []).filter((question) => (
      question?.id && !handled.has(question.id)
    ));
    if (!questions.length) {
      return { ok: true, outcome: 'nothing_to_do', answered: 0 };
    }

    const registry = await this.providerRegistry();
    const resolved = resolveModelRef(settings.triageModel, registry);
    if (!resolved.ok) {
      return { ok: false, error: 'analysis_model_unavailable' };
    }
    const executor = await this.executorFor(resolved.modelRef.provider);
    if (!await supportsScopedWorkspace(executor, this.analyzer.config)) {
      return { ok: false, error: 'analysis_model_unsafe' };
    }
    const efforts = Array.isArray(resolved.model?.efforts) ? resolved.model.efforts : [];
    const effort = efforts.includes(settings.triageModel?.effort)
      ? settings.triageModel.effort
      : null;
    const profile = await this.analyzer.profile();
    const staging = await fs.mkdtemp(path.join(this.analyzer.dir, `.t${id}.arbiter-`));
    try {
      const output = path.join(staging, 'output');
      await fs.mkdir(output);
      const readableRoots = await this.analyzer._readableRoots(profile, output);
      const prompt = [
        'Ты — арбитр вопросов триажа. Проверь вопросы по доступному коду.',
        'factual можно закрыть только доказанным ответом с proof (путь:строка).',
        'product_choice, priority и scope_change всегда верни human_required без ответа.',
        'Верни только JSON {"answers":[{"questionId","kind","status","text","proof":[]}]}',
        JSON.stringify({ task: Number(id), questions }),
      ].join('\n\n');
      const workTools = createRepoHistoryTools(profile.repos || []);
      const workIpc = executor.workToolsTransport === 'mcp'
        ? await createWorkIpc({ workTools, root: staging })
        : null;
      let response;
      try {
        response = await executor.run({
          config: this.analyzer.config,
          env: this.analyzer.claudeAuth?.env?.() || process.env,
          message: prompt,
          prompt,
          cwd: output,
          model: resolved.modelRef.model,
          effort,
          permissionMode: 'plan',
          providerSettings: this.analyzer.prefs?.read?.().providerSettings?.[
            resolved.modelRef.provider
          ] || {},
          workspaceAccess: {
            readableRoots,
            writableRoots: [output],
            networkAccess: false,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
            allowExternalMcp: false,
            allowBash: false,
            tools: ['Read', 'Glob', 'Grep', 'repo_history'],
          },
          workTools,
          ...(workIpc ? { mcpConfig: { mcpServers: { 'cockpit-work': workIpc.mcpServer } } } : {}),
        });
      } finally {
        await workIpc?.close().catch(() => {});
      }
      const parsed = parseReply(response?.reply);
      const byId = new Map(questions.map((question) => [question.id, question]));
      const answers = [];
      for (const candidate of Array.isArray(parsed?.answers) ? parsed.answers : []) {
        const questionId = String(candidate?.questionId || '');
        if (!byId.has(questionId) || answers.some((entry) => entry.questionId === questionId)) {
          continue;
        }
        const proof = Array.isArray(candidate.proof)
          ? candidate.proof.map(String).filter(Boolean).slice(0, 20)
          : [];
        const factual = candidate.kind === 'factual'
          && candidate.status === 'answered'
          && String(candidate.text || '').trim()
          && proof.length;
        answers.push({
          questionId,
          optionIds: [],
          status: factual ? 'answered' : 'human_required',
          text: factual ? String(candidate.text).trim() : '',
          proof: factual ? proof : [],
          attachments: [],
        });
      }
      if (!answers.length) {
        return { ok: false, error: 'analysis_arbiter_invalid_result' };
      }

      const appended = await this.analyzer.appendClarificationBatch(id, answers, {
        actor: 'cockpit-arbiter',
      });
      if (!appended.ok) {
        return appended;
      }
      const answered = appended.entries.filter((entry) => entry.status === 'answered').length;
      if (answered > 0) {
        await this.analyzer.enqueue(id);
      }
      return { ok: true, outcome: answered ? 'answered' : 'human_required', answered };
    } catch (error) {
      this.log?.warn({ task: id, err: error?.message }, 'арбитр триажа не отработал');
      return { ok: false, error: String(error?.message || error) };
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export default AnalysisArbiter;
