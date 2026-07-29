// Модуль factory (read-only, M0) — отдаёт состояние конвейера в чистом JSON,
// которого нет у Python-дашборда (там server-rendered HTML). Мутации (ворота/запуск)
// добавятся отдельным этапом через factory-cli.
import fp from 'fastify-plugin';
import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { STAGES, StageKind } from '../../lib/stages.js';
import { setPipeline, writeInstruction, readInstruction, readActivity, readAgentLive } from '../../lib/factory-cli.js';
import { taskDiff } from '../../lib/git.js';
import { refreshRepos } from '../../lib/git-refresh.js';
import { loadTriageProfile } from '../../lib/analysis/profile.js';
import { reserveSlot, releaseSlot, slotsOverview, SlotsFullError } from '../../lib/sandbox-slots.js';
import { recoveryDecision } from '../../lib/pipeline-recovery.js';
import { factoryLaunchEnv } from '../../lib/factory-launch.js';
import {
  FactoryRunnerControl,
  RunnerControlCommandError,
  RunnerControlInputError,
} from '../../lib/runner-control.js';
import {
  ManualStageTransitionError,
  manualStageTransitionPairs,
} from '../../lib/factory-transition.js';

// Допустимые статусы для ручного перехода (форс).
const STAGE_STATUSES = new Set(['pending', 'running', 'done', 'waiting', 'skipped', 'failed', 'approved', 'rejected']);

async function factoryModule(fastify, opts) {
  const { factoryState, config, prefs, b24, analyzer } = opts;
  const cfg = { factoryHome: config.factoryHome, stateDir: config.stateDir };
  const runnerControl = new FactoryRunnerControl({
    factoryBin: config.factoryBin,
    stateDir: config.stateDir,
    configRoot: config.factoryConfigRoot,
    profilesDir: config.profilesDir,
  });

  // Список всех задач с картой статусов этапов.
  fastify.get('/api/tasks', async () => {
    const tasks = await factoryState.listTasks();
    return { tasks };
  });

  // Деталь одной задачи: реестр + карта этапов + таймлайн.
  fastify.get('/api/tasks/:id', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    try {
      return await factoryState.getTaskDetail(id);
    } catch (err) {
      return reply.code(404).send({ error: 'not_found', message: err.message });
    }
  });

  // Документ этапа — человеку у ворот: план (утверждение), разведнота, диагноз,
  // шип-инструкция, отчёт браузерной проверки. Без него решение по воротам слепое.
  const STAGE_DOCS = { plan: 'plan.md', recon: 'recon.md', diag: 'diag.md', ship: 'ship.md', report: 'report.md' };
  fastify.get('/api/tasks/:id/doc/:name', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    const file = STAGE_DOCS[request.params.name];
    if (!id || !file) return reply.code(400).send({ error: 'bad_doc' });
    try { return { text: await fs.readFile(path.join(config.stateDir, `t${id}.${file}`), 'utf8') }; }
    catch { return { text: '' }; }
  });

  // Воркдиры задачи (worktree бэка/фронта) — для кнопки «Открыть в VS Code».
  fastify.get('/api/tasks/:id/workspace', async (request) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    const env = id ? await factoryState.readEnv(id) : {};
    return { beWt: env.BE_WT || null, feWt: env.FE_WT || null };
  });

  // Диф задачи (несохранённые изменения воркдиров бэка/фронта) — для приёмки.
  fastify.get('/api/tasks/:id/diff', async (request) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    const env = id ? await factoryState.readEnv(id) : {};
    const repos = [];
    for (const [name, wt] of [['be', env.BE_WT], ['fe', env.FE_WT]]) {
      if (!wt) continue;
      try { repos.push({ name, path: wt, ...(await taskDiff(wt)) }); }
      catch (e) { repos.push({ name, path: wt, error: e.message, stat: '', files: [] }); }
    }
    return { repos };
  });

  // Глобальный каталог стадий (enum) — для будущего редактора профилей.
  fastify.get('/api/factory/stages', async () => ({ kinds: StageKind, stages: STAGES }));

  // Эталонные схемы маршрутов. Профиль — из запроса, иначе определяется по данным
  // (активные задачи / обнаруженные схемы). Пустой кокпит вернёт profile:null.
  fastify.get('/api/factory/routes', async (request, reply) => {
    try {
      const profile = request.query.profile || (await factoryState.primaryProfile());
      const profiles = factoryState.discoverProfiles();
      if (!profile) return { profile: null, profiles, default: null, routes: {} };
      return { ...factoryState.getRoutes(profile), profiles };
    } catch (err) {
      return reply.code(500).send({ error: 'graph_error', message: err.message });
    }
  });

  // Запуск конвейера — общий для «направить задачу» и «перезапустить стенд».
  // Обе кнопки поднимают ОДНОГО И ТОГО ЖЕ демона фабрики: отдельной операции «собрать
  // стенд» в движке нет — песочница строится фоном ВНУТРИ прогона (lib/core.sh), и
  // вернуть задачу в работу после упавшего подъёма можно только новым прогоном.
  // Возвращает { status, body }: status=null — успех, иначе код ответа.
  //
  // Контракт: factory bin при ошибке аргументов → rc≠0; при занятом локе → rc=0.
  // Исход читаем из состояния (ORCH_PID + /proc), не из stdout.
  async function startPipeline(id, {
    ticket,
    route,
    profile: reqProfile,
    recovery = false,
  } = {}) {
    const profile = reqProfile || config.factoryProfile || (await factoryState.primaryProfile());
    if (!profile) return { status: 400, body: { error: 'no_profile', message: 'профиль конвейера не определён' } };

    // Уже идёт?
    let reg = null;
    try { reg = (await factoryState.readRegistry(id)).registry; } catch { /* реестра ещё нет */ }
    if (reg && factoryState.isDaemonAlive(reg.ORCH_PID, id)) return { status: null, body: { outcome: 'already_running', profile } };

    // Правило кокпита: конвейер стартует со свежего кода (worktree задачи форкается
    // от локального master). Безопасно: ff-only и только чистый master; сбой
    // обновления запуск не блокирует — фиксируется в ответе.
    let gitRefresh = null;
    if (!recovery && prefs?.read().gitRefreshBeforeRun) {
      try {
        const triageProfile = await loadTriageProfile(config, profile);
        gitRefresh = await refreshRepos(triageProfile.repos);
        fastify.log.info({ task: id, gitRefresh }, 'репозитории обновлены перед конвейером');
      } catch (e) {
        fastify.log.warn({ task: id, err: e.message }, 'обновление репозиториев перед конвейером не удалось');
      }
    }
    // Живой незавершённый реестр = продолжение прогона: у фабрики для этого есть
    // режим resume (start реинициализирует реестр и гонит цепочку заново со скаута —
    // так резюм #7803 дважды пере-прогонял разведку).
    const mode = reg && reg.WF_STATUS === 'running' ? 'resume' : 'start';
    const args = [id, mode, '--profile', profile];
    // Тикет = название+описание с фронта ПЛЮС контекст, которого нет в описании:
    //  • локальные уточнения человека (t<id>.clarify.md — ответы на вопросы триажа,
    //    скрины; в B24 их НЕ публикуем — заказчик видит комментарии);
    //  • несистемные комментарии задачи из B24 (переписка по существу).
    // Без этого конвейер стартует слепее триажа и переспрашивает отвеченное.
    let fullTicket = ticket ? String(ticket) : '';
    if (fullTicket && mode === 'start') {
      const clarify = await analyzer.readClarifications(id);
      if (clarify) fullTicket += `\n\n[Внутренние уточнения человека — приоритетнее описания; пометки «[приложено фото: /путь]» открывай инструментом Read]\n${clarify.slice(0, 6000)}`;
      if (b24) {
        try {
          const page = await b24.taskPageData(id);
          const comm = (page.comments || [])
            .filter((c) => !c.isSystem && c.text)
            .map((c) => `— ${c.author}${c.time ? ` (${c.time})` : ''}: ${c.text}`)
            .join('\n');
          if (comm) fullTicket += `\n\n[Комментарии к задаче из трекера]\n${comm}`;
        } catch (e) {
          fastify.log.warn({ task: id, err: e.message }, 'комментарии для тикета не получены — конвейер стартует без них');
        }
      }
      args.push('--ticket', fullTicket.slice(0, 12000));
    }
    if (route) args.push('--route', route);

    // СЛОТ СТЕНДА резервируем ЗДЕСЬ, до запуска. Внутри подъёма индекс выбирается за
    // двадцать минут до того, как попадёт в реестр песочниц, и всё это окно выглядит
    // свободным: #7789 и #7804 так взяли один и тот же k=5, и второй умер на
    // «Address already in use», потеряв весь провижининг. Кокпит — единственная точка
    // запуска на машине, поэтому окно закрывается здесь: под локом выбрали, записали,
    // передали конвейеру. Дальше стенд подтвердит слот в реестре, и резервация снимется.
    let slot = { k: null, source: 'none' };
    try {
      slot = await reserveSlot({
        factoryBin: config.factoryBin,
        stateDir: config.stateDir,
        profilesDir: config.profilesDir,
        profile,
        task: id,
      });
    } catch (e) {
      // Слотов нет — отказываем СРАЗУ и по-человечески. Раньше это выяснялось только
      // через двадцать минут клонирования БД, докерной ошибкой в логе оркестратора.
      if (e instanceof SlotsFullError) {
        return { status: 409, body: { outcome: 'no_slot', message: e.message, slots: e.details } };
      }
      throw e;
    }
    if (slot.source === 'none' && slot.reason) {
      fastify.log.warn({ task: id, err: slot.reason }, 'слот стенда не зарезервирован — конвейер выберет сам');
    }
    // source='registry' — стенд уже поднят и слот за ним закреплён: подсказывать нечего,
    // а навязанный индекс сломал бы проверку занятости внутри подъёма.
    const slotEnv = (slot.k !== null && slot.source !== 'registry') ? { FACTORY_SB_K: String(slot.k) } : {};
    const launchEnv = factoryLaunchEnv(config, slotEnv);
    // КРИТИЧНО: оркестратор живёт ЧАСЫ и обязан пережить рестарт кокпита.
    // Прогон #7803 умер именно так: сервер работал под systemd-юнитом, фабрика
    // родилась в его cgroup, и при рестарте systemd зачистил cgroup целиком (TERM
    // демону и claude-агенту). Поэтому фабрика уезжает в СВОЙ transient scope
    // (systemd-run --user --scope) — отдельный cgroup, жизнь кокпита её не касается.
    // Без systemd — просто полная отвязка: detached, вывод в файл, unref.
    const launchLog = path.join(config.stateDir, `t${id}.launch.log`);
    const out = await fs.open(launchLog, 'a');
    const haveScope = await new Promise((res) => execFile('systemd-run', ['--version'], (err) => res(!err)));
    // Слот передаётся ДВАЖДЫ намеренно: env — для случая без systemd, --setenv — потому
    // что transient scope не обязан донести окружение вызывающего до самой команды.
    const scopeEnv = Object.entries(launchEnv).map(([k, v]) => `--setenv=${k}=${v}`);
    const [bin, argv] = haveScope
      ? ['systemd-run', ['--user', '--scope', '--quiet', '--collect', ...scopeEnv, `--unit=factory-t${id}`, config.factoryBin, ...args]]
      : [config.factoryBin, args];
    const child = spawn(bin, argv, {
      detached: true,
      stdio: ['ignore', out.fd, out.fd],
      env: { ...process.env, ...launchEnv },
    });
    child.unref();
    let exited = null; // быстрый выход = ошибка аргументов/профиля
    child.on('exit', (code) => { exited = code ?? 1; });
    const slotInfo = slot.k === null ? null : { k: slot.k, source: slot.source };

    // Опрос ORCH_PID до ~10с.
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => { setTimeout(r, 250); });
      try {
        const r2 = (await factoryState.readRegistry(id)).registry;
        if (factoryState.isDaemonAlive(r2.ORCH_PID, id)) { await out.close(); return { status: null, body: { outcome: 'launched', profile, gitRefresh, slot: slotInfo } }; }
      } catch { /* реестр ещё пишется */ }
      if (exited !== null && exited !== 0) {
        await out.close();
        // Конвейер не стартовал — держать за ним слот незачем, иначе одна опечатка
        // в аргументах выводит слот из оборота на весь TTL резервации.
        if (slot.source === 'new') releaseSlot({ stateDir: config.stateDir, task: id });
        return { status: 500, body: { outcome: 'invalid', message: `factory bin завершился с кодом ${exited} — смотри ${launchLog}` } };
      }
    }
    await out.close();
    return { status: null, body: { outcome: 'started', profile, gitRefresh, slot: slotInfo, note: 'демон не подтвердил PID за 10с — проверь конвейер' } };
  }

  // Запуск задачи на конвейер (замена входа через хук на mcp__b24__b24_task).
  fastify.post('/api/tasks/:id/launch', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    const r = await startPipeline(id, request.body || {});
    return r.status ? reply.code(r.status).send(r.body) : r.body;
  });

  // После перезапуска машины/кокпита незакрытый конвейер мог остаться без демона.
  // Восстанавливаем только доказанный crash: не пересекаем ворота, human-stall и
  // завершённые прогоны. Бюджет защищает от цикла, профиль проверяется до запуска.
  let recoveryReport = {
    enabled: prefs?.read().autoRecoverPipelines === true,
    running: false,
    checkedAt: null,
    items: [],
  };

  async function profileAvailable(profile) {
    if (!/^[a-zA-Z0-9_-]+$/.test(profile || '')) return false;
    const dir = path.join(config.profilesDir, profile);
    try {
      await Promise.all([
        fs.access(path.join(dir, 'profile.sh')),
        fs.access(path.join(dir, 'runners.env')),
        fs.access(path.join(dir, 'graph.json')),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async function recoverPipelines() {
    const enabled = prefs?.read().autoRecoverPipelines === true;
    const items = [];
    recoveryReport = { enabled, running: enabled, checkedAt: Date.now(), items };
    if (!enabled) {
      recoveryReport.running = false;
      return recoveryReport;
    }

    for (const id of await factoryState.listTaskIds()) {
      try {
        const { registry } = await factoryState.readRegistry(id);
        const alive = factoryState.isDaemonAlive(registry.ORCH_PID, id);
        const available = await profileAvailable(registry.PROFILE);
        const decision = recoveryDecision({
          registry,
          daemonAlive: alive,
          profileAvailable: available,
        });
        const item = { task: id, ...decision };
        items.push(item);

        if (decision.action === 'attention') {
          const pairs = ['NEEDS_RUN', '1', 'RECOVERY_REASON', decision.reason];
          if (decision.reason === 'restart_limit') pairs.push('STALLED_HUMAN', '1');
          await setPipeline({ ...cfg, task: id, pairs });
          fastify.log.warn({ task: id, reason: decision.reason }, 'автовосстановление конвейера требует внимания');
          continue;
        }
        if (decision.action !== 'resume') continue;

        await setPipeline({
          ...cfg,
          task: id,
          pairs: [
            'RECOVERY_RESTARTS', String(decision.nextCount),
            'RECOVERY_WINDOW_AT', String(decision.windowAt),
            'RECOVERY_LAST_AT', String(Date.now()),
            'RECOVERY_REASON', 'startup_crash',
            'NEEDS_RUN', '0',
          ],
        });
        const result = await startPipeline(id, {
          profile: registry.PROFILE,
          route: registry.ROUTE,
          recovery: true,
        });
        item.outcome = result.body?.outcome || 'unknown';
        item.ok = !result.status;
        if (result.status) {
          item.error = result.body?.message || result.body?.error || `HTTP ${result.status}`;
          await setPipeline({
            ...cfg,
            task: id,
            pairs: ['NEEDS_RUN', '1', 'RECOVERY_REASON', 'restart_failed'],
          });
        }
        fastify.log[result.status ? 'warn' : 'info'](
          { task: id, profile: registry.PROFILE, outcome: item.outcome, error: item.error },
          result.status ? 'автовосстановление конвейера не удалось' : 'конвейер восстановлен после перезапуска',
        );
      } catch (e) {
        items.push({ task: id, action: 'attention', reason: 'recovery_error', error: e.message });
        fastify.log.error({ task: id, err: e.message }, 'ошибка проверки автовосстановления конвейера');
      }
    }
    recoveryReport = { enabled, running: false, checkedAt: Date.now(), items };
    return recoveryReport;
  }

  fastify.get('/api/factory/recovery', async () => recoveryReport);

  let recoveryTimer = null;
  fastify.addHook('onReady', async () => {
    recoveryTimer = setTimeout(() => {
      recoverPipelines().catch((e) => {
        recoveryReport = {
          ...recoveryReport,
          running: false,
          checkedAt: Date.now(),
          error: e.message,
        };
        fastify.log.error({ err: e.message }, 'автовосстановление конвейеров не выполнено');
      });
    }, 1500);
    recoveryTimer.unref?.();
  });
  fastify.addHook('onClose', async () => { if (recoveryTimer) clearTimeout(recoveryTimer); });

  // Занятость слотов стенда: чем заняты, что зарезервировано, сколько свободно.
  // Нужна человеку, когда запуск отказал с no_slot — иначе непонятно, что освобождать.
  fastify.get('/api/factory/slots', async (request, reply) => {
    const profile = request.query.profile || config.factoryProfile || (await factoryState.primaryProfile());
    if (!profile) return reply.code(400).send({ error: 'no_profile', message: 'профиль конвейера не определён' });
    return slotsOverview({
      factoryBin: config.factoryBin,
      stateDir: config.stateDir,
      profilesDir: config.profilesDir,
      profile,
    });
  });

  // Ворота: принять/отклонить (+ комментарий агенту при отклонении).
  fastify.post('/api/tasks/:id/gate/:key/:decision', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    const key = String(request.params.key).toUpperCase();
    const decision = request.params.decision;
    // Только GATE_*: других ворот у движка нет. DEMO_ASK был исключением, пока демо стояло
    // в цепочке; теперь оно снимается кнопкой плагина «Демо», а не ответом на воротах.
    if (!id || !key.startsWith('GATE_')) return reply.code(400).send({ error: 'bad_gate' });
    if (!['approve', 'reject'].includes(decision)) return reply.code(400).send({ error: 'bad_decision' });
    const value = decision === 'approve' ? 'approved' : 'rejected';
    const comment = ((request.body || {}).comment || '').replace(/\n/g, ' ').slice(0, 500);
    const pairs = [key, value];
    if (comment) pairs.push(`${key}_COMMENT`, comment);
    try { await setPipeline({ ...cfg, task: id, pairs }); return { ok: true, key, value }; }
    catch (err) { return reply.code(500).send({ error: 'gate_failed', message: err.message }); }
  });

  // Принудительный переход/статус этапа (форс).
  fastify.post('/api/tasks/:id/stage/:key/:status', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    const key = String(request.params.key).toUpperCase().replace(/[^A-Z0-9_]/g, '');
    const status = request.params.status;
    if (!id || !key) return reply.code(400).send({ error: 'bad_input' });
    if (!STAGE_STATUSES.has(status)) return reply.code(400).send({ error: 'bad_status' });
    try {
      const { registry } = await factoryState.readRegistry(id);
      const { stages } = factoryState.buildStageMap(registry);
      const pairs = manualStageTransitionPairs({ registry, stages, key, status });
      await setPipeline({ ...cfg, task: id, pairs });
      return { ok: true, key, status };
    } catch (err) {
      if (err instanceof ManualStageTransitionError) {
        return reply.code(409).send({ error: err.code, message: err.message });
      }
      return reply.code(500).send({ error: 'stage_failed', message: err.message });
    }
  });

  // Ручное переключение ТОЛЬКО активной попытки и ТОЛЬКО на provider из уже
  // разрешённой цепочки этого этапа. Сам engine применяет CAS к run/epoch и завершает
  // точную process group; Cockpit не пишет control-файлы напрямую.
  fastify.post('/api/tasks/:id/runner/switch', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    const stage = String(request.body?.stage || '').toUpperCase();
    const target = String(request.body?.target || '');
    if (!id || !/^[A-Z][A-Z0-9_]*$/.test(stage) || !/^[a-z][a-z0-9_-]*$/.test(target)) {
      return reply.code(400).send({ error: 'bad_runner_switch' });
    }
    try {
      const graph = await factoryState.getTaskGraph(id);
      const nodeId = Object.keys(graph.runnerKeys || {}).find((nid) => graph.runnerKeys[nid] === stage)
        || Object.keys(graph.keys || {}).find((nid) => graph.keys[nid] === stage)
        || Object.keys(graph.nodes || {}).find((nid) => nid.toUpperCase() === stage);
      const runner = nodeId ? graph.nodeMeta?.[nodeId]?.runner : null;
      if (!runner?.actual) {
        return reply.code(409).send({
          error: 'runner_not_active',
          message: 'У этапа нет активного запуска для переключения.',
        });
      }
      if (target === runner.actual || !runner.chain.includes(target)) {
        return reply.code(409).send({
          error: 'runner_not_allowed',
          message: 'Исполнитель не входит в разрешённую резервную цепочку этапа.',
        });
      }
      return await runnerControl.switch({ task: id, stage, target });
    } catch (err) {
      if (err instanceof RunnerControlInputError) {
        return reply.code(400).send({ error: 'bad_runner_switch', message: err.message });
      }
      if (err instanceof RunnerControlCommandError) {
        return reply.code(409).send({ error: 'runner_switch_rejected', message: err.message });
      }
      return reply.code(500).send({ error: 'runner_switch_failed', message: err.message });
    }
  });

  // Указание агенту (side-файл, читается на границе этапов). Пусто — снять.
  fastify.get('/api/tasks/:id/instruction', async (request) => ({ text: readInstruction({ ...cfg, task: String(request.params.id).replace(/[^0-9]/g, '') }) }));
  fastify.post('/api/tasks/:id/instruction', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    try {
      writeInstruction({ ...cfg, task: id, text: (request.body || {}).text || '' });
      if ((request.body || {}).text) await setPipeline({ ...cfg, task: id, pairs: ['INSTRUCTION_AT', new Date().toISOString().slice(0, 19).replace('T', ' ')] }).catch(() => {});
      return { ok: true };
    } catch (err) { return reply.code(500).send({ error: 'instruction_failed', message: err.message }); }
  });

  // Живая активность прогона (для поллинга в модалке).
  fastify.get('/api/tasks/:id/activity', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    try {
      const { registry } = await factoryState.readRegistry(id);
      const activity = readActivity({ ...cfg, task: id, registry });
      const live = readAgentLive({ stateDir: cfg.stateDir, task: id, registry });
      return { ...activity, live };
    } catch (err) { return reply.code(404).send({ error: 'not_found', message: err.message }); }
  });

  // Команда сноса стенда: COCKPIT_SANDBOX_DOWN_CMD ({task} подставляется); без неё —
  // дефолт из профиля фабрики задачи: profiles/<profile>/down.sh <task> (тот же скрипт,
  // которым стенд сносит сама фабрика). Нет ни того ни другого → null.
  const NOT_CONFIGURED = 'снос не настроен: нет COCKPIT_SANDBOX_DOWN_CMD и down.sh у профиля';
  async function sandboxDownCmd(id) {
    if (config.sandboxDownCmd) return config.sandboxDownCmd.replaceAll('{task}', id);
    let profile = '';
    try { profile = (await factoryState.readRegistry(id)).registry.PROFILE || ''; } catch { /* реестра нет */ }
    const script = profile && path.join(config.profilesDir, profile, 'down.sh');
    if (script && await fs.access(script).then(() => true).catch(() => false)) return `bash ${script} ${id}`;
    return null;
  }

  // Выполнить снос. Решение по ответу оставляем вызывающему: снос — это и отдельная
  // кнопка, и первый шаг перезапуска стенда, а реагируют они на отказ по-разному.
  function runSandboxDown(id, cmd) {
    return new Promise((resolve) => {
      execFile('sh', ['-c', cmd], { timeout: 120000 }, (err, stdout, stderr) => {
        if (err) resolve({ ok: false, message: (stderr || err.message).slice(-500) });
        else {
          // Стенда больше нет — незачем держать за задачей резервацию до истечения TTL.
          releaseSlot({ stateDir: config.stateDir, task: id });
          resolve({ ok: true, output: (stdout || '').slice(-500) });
        }
      });
    });
  }

  // Снос стенда задачи.
  fastify.post('/api/tasks/:id/sandbox/down', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    const cmd = await sandboxDownCmd(id);
    if (!cmd) return reply.code(501).send({ error: 'not_configured', message: NOT_CONFIGURED });
    const down = await runSandboxDown(id, cmd);
    if (!down.ok) return reply.code(500).send({ error: 'sandbox_down_failed', message: down.message });
    return { ok: true, output: down.output };
  });

  // Перезапуск стенда после провала подъёма.
  //
  // Кнопка «снести стенд» показывается только у ЖИВОГО стенда (её условие — известный
  // порт фронта), а когда подъём упал, порта нет — и вернуть задачу в работу из
  // интерфейса было нечем. Движок при этом ставит STALLED_HUMAN=1 и выходит, НИЧЕГО за
  // собой не убирая (намеренно: следы падения нужны для разбора). #7789 так и встал:
  // первая попытка умерла на занятом порту, вторая — мгновенно, на гарде «схема db_t7789
  // уже существует», потому что остатки первой никто не снёс. Поэтому кнопка делает ДВА
  // шага: сносит остатки (down.sh идемпотентен — дропает по точным именам, чего нет,
  // то и не трогает) и поднимает конвейер заново. Заново — это resume: разведка,
  // маршрут и пройденные этапы в реестре уцелеют, стенд соберётся фоном.
  fastify.post('/api/tasks/:id/sandbox/retry', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });

    let reg = null;
    try { reg = (await factoryState.readRegistry(id)).registry; } catch { /* реестра нет */ }
    if (!reg) return reply.code(404).send({ error: 'not_found', message: `реестра задачи #${id} нет — направь её на конвейер заново` });
    // Сносить песочницу под работающим конвейером нельзя: агент этапа потеряет и код,
    // и базу под собой.
    if (factoryState.isDaemonAlive(reg.ORCH_PID, id)) {
      return reply.code(409).send({ error: 'running', message: 'конвейер идёт — перезапускать стенд нечего' });
    }
    // Прогон закрыт (или ещё не начинался): resume продолжать нечего, а start без тикета
    // ушёл бы работать вслепую. Для этого есть кнопка «на конвейер» — с описанием задачи.
    if (reg.WF_STATUS !== 'running') {
      return reply.code(409).send({ error: 'not_running', message: 'прогон не открыт — запускай задачу кнопкой «на конвейер»' });
    }

    const cmd = await sandboxDownCmd(id);
    if (!cmd) return reply.code(501).send({ error: 'not_configured', message: NOT_CONFIGURED });
    const down = await runSandboxDown(id, cmd);
    if (!down.ok) return reply.code(500).send({ error: 'sandbox_down_failed', message: down.message });

    const r = await startPipeline(id, { route: (request.body || {}).route });
    // Снос уже прошёл, поэтому его вывод отдаём в ЛЮБОМ случае: там видны отказы,
    // из-за которых новый подъём упадёт снова (например «worktree ОСТАВЛЕН» —
    // в нём незакоммиченные изменения, и гард подъёма упрётся именно в это).
    if (r.status) return reply.code(r.status).send({ ...r.body, downOutput: down.output });
    return { ...r.body, retried: true, downOutput: down.output };
  });

  // Полный граф конвейера задачи (для SVG-отрисовки): схема + статусы узлов + возвраты.
  fastify.get('/api/tasks/:id/graph', async (request, reply) => {
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return reply.code(400).send({ error: 'bad_task_id' });
    try {
      return await factoryState.getTaskGraph(id);
    } catch (err) {
      return reply.code(404).send({ error: 'not_found', message: err.message });
    }
  });
}

export default fp(factoryModule, { name: 'module-factory' });
