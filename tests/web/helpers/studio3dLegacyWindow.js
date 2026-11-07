import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { serialize } from 'node:v8';
import { build } from '../../../web/node_modules/esbuild/lib/main.js';

const artifactRoot = '/home/evildev/.grigdesk/artifacts/studio3d-extraction';
const developmentDir = process.env.STUDIO3D_DEVELOPMENT_DIR;
const SOURCE = Object.freeze({
  'pendingIntentController.ts.source.txt':
    '41a9662f26564e54908699930094489b6d6721cdd4da7a3130d91591f4942bb4',
  'studio3dApi.ts.source.txt':
    '913db7179130655b509f24b7541c553853bc8c40f8cd8e27abea36f03c5789a9',
});

const childSource = `
import {createPendingIntentController} from 'legacy-controller';
import {Studio3dApiError} from 'legacy-api';
export {Studio3dApiError} from 'legacy-api';
import {studioFingerprint} from 'current-fingerprint';

let controller;
let session;
let records=[];
let rpcSeq=0;
const pending=new Map();
const send=value=>process.send?.(value);
const rpc=(op,args=[])=>new Promise((resolve,reject)=>{
  const id=++rpcSeq;
  pending.set(id,{resolve,reject});
  send({kind:'rpc',id,op,args});
});
const notice=(event,data)=>send({kind:'event',event,data});

process.on('message',message=>{
  if(message.kind==='rpc-result') {
    const waiting=pending.get(message.id);
    if(!waiting)return;
    pending.delete(message.id);
    if(message.error) {
      const cause=message.error.status
        ?new Studio3dApiError(message.error.status,message.error.code,message.error.body)
        :new Error(message.error.message);
      waiting.reject(cause);
    } else waiting.resolve(message.data);
    return;
  }
  if(message.kind==='init') {
    session={owner:message.owner,libraryId:message.libraryId,generation:1,started:true,libraryOk:true};
    controller=createPendingIntentController({
      storage:{list:owner=>rpc('list',[owner]),put:record=>rpc('put',[record]),
        remove:key=>rpc('remove',[key])},
      api:{run:body=>rpc('run',[body]),retry:()=>{throw new Error('Unexpected retry');},
        batchRun:()=>{throw new Error('Unexpected batch');},job:(key,libraryId)=>rpc('job',[key,libraryId])},
      fingerprint:studioFingerprint,now:Date.now,uuid:()=>{throw new Error('UUID must be captured');},
      session:()=>session,
      pending:{list:()=>records,add:record=>records.push(record),
        replace:record=>{records=records.map(item=>item.key===record.key?record:item);},
        remove:key=>{records=records.filter(item=>item.key!==key);},reset:rows=>{records=rows;}},
      busy:{begin(){},end(){}},onSent:value=>notice('sent',value),
      onError:cause=>notice('error',cause.message),onDropped:record=>notice('dropped',record.key),
    });
    send({kind:'ready'});
    return;
  }
  if(message.kind==='abort') {
    session={...session,started:false,generation:session.generation+1};
    send({kind:'result',id:message.id,data:'aborted'});
    return;
  }
  if(message.kind==='shutdown')process.exit(0);
  const work=message.kind==='submit'
    ?controller.submit('run',message.input,message.key):controller.recoverPending();
  Promise.resolve(work).then(data=>send({kind:'result',id:message.id,data}),
    cause=>send({kind:'result',id:message.id,error:{message:cause.message,
      status:cause.status,code:cause.code}}));
});
`;

/**
 * Оба historical модуля читаются побайтно и проверяются по заранее закреплённым SHA.
 * Resolver меняет только расположение imports; API error class и controller разделяют один bundle.
 */
async function buildOldWindow(directory) {
  assert.ok(developmentDir && path.isAbsolute(developmentDir));

  const snapshots = path.join(developmentDir, 'tests/fixtures/controller-legacy-v1');
  const bytes = new Map();

  for (const [name, digest] of Object.entries(SOURCE)) {
    const source = await fs.readFile(path.join(snapshots, name));

    assert.equal(createHash('sha256').update(source).digest('hex'), digest, name);
    bytes.set(name, source.toString('utf8'));
  }

  const entry = path.join(directory, 'legacy-window.mjs');

  await build({
    stdin: {
      contents: childSource,
      sourcefile: 'legacy-window.ts',
      loader: 'ts',
      resolveDir: directory,
    },
    outfile: entry,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
    plugins: [{
      name: 'exact-historical-controller',
      /**
       * Source text не переписывается: разрешены только его известные относительные связи.
       * API transport не используется controller ports, поэтому stub не создаёт отдельный HTTP путь.
       */
      setup(builder) {
        builder.onResolve({ filter: /^legacy-controller$/ }, () => ({
          path: 'pendingIntentController.ts.source.txt', namespace: 'historical',
        }));
        builder.onResolve({ filter: /^legacy-api$/ }, () => ({
          path: 'studio3dApi.ts.source.txt', namespace: 'historical',
        }));
        builder.onResolve({ filter: /^current-fingerprint$/ }, () => ({
          path: path.join(developmentDir, 'src/web/features/studio3d/pendingIntents.ts'),
        }));
        builder.onResolve({ filter: /.*/, namespace: 'historical' }, (args) => {
          if (args.path === './studio3dApi.ts') {
            return { path: 'studio3dApi.ts.source.txt', namespace: 'historical' };
          }
          if (args.path === '../../../../shared/studio3d/studio3dContracts.ts') {
            return { path: path.join(developmentDir, 'src/shared/studio3d/studio3dContracts.ts') };
          }
          if (args.path === './presentation.ts') {
            return { path: path.join(developmentDir, 'src/web/features/studio3d/presentation.ts') };
          }
          if (args.path === '../../shared/apiClient.ts') {
            return { path: 'transport', namespace: 'old-api-stub' };
          }

          throw new Error(`Неизвестный historical import ${args.path}`);
        });
        builder.onLoad({ filter: /.*/, namespace: 'historical' }, (args) => ({
          contents: bytes.get(args.path), loader: 'ts',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'old-api-stub' }, () => ({
          contents: 'export const api={}; export class ApiError extends Error {}', loader: 'js',
        }));
      },
    }],
  });
  await fs.writeFile(path.join(directory, 'SOURCE_SHA.json'), JSON.stringify(SOURCE, null, 2));

  return entry;
}

/**
 * Child имитирует уничтожаемый JS-context старого окна, а storage RPC идёт в настоящий parent IDB.
 * Disk mirror фиксирует durable boundary, не заменяя IndexedDB своей Map или второй фабрикой.
 */
export async function oldStudioWindow(t, f, { owner, libraryId, network }) {
  const directory = await fs.mkdtemp(path.join(artifactRoot, 'old-window-'));
  const entry = await buildOldWindow(directory);
  const child = spawn(f.environment().nodeExecutable, [entry], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    serialization: 'advanced',
    env: { NODE_ENV: 'test' },
  });
  const ready = Promise.withResolvers();
  const exit = Promise.withResolvers();
  const commands = new Map();
  const events = [];
  const rpcCalls = [];
  let stderr = '';
  let exited = false;
  let sequence = 0;
  let mutations = 0;
  let suppressedReplies = 0;
  let mutationChain = Promise.resolve();

  child.stderr.on('data', chunk => {
    stderr = (stderr + chunk).slice(-4096);
  });
  child.once('error', cause => ready.reject(cause));
  child.once('exit', (code, signal) => {
    exited = true;
    events.push('child-exit');
    exit.resolve({ code, signal });

    for (const [id, waiting] of commands) {
      waiting.resolve({ id, error: { message: 'context_closed' } });
    }

    commands.clear();
  });

  /**
   * Reply после exit не отправляется и не может вызвать legacy callback с storage mutation.
   * Отдельный счётчик показывает доставку позднего сетевого исхода без живого получателя.
   */
  const reply = message => {
    if (exited || !child.connected) {
      suppressedReplies += 1;

      return;
    }

    child.send(message, () => {});
  };
  /**
   * Checkpoint записывает уже завершённую IDB transaction через atomic rename в artifacts.
   * После exit эти bytes сверяются перед запуском нового background той же IDB factory.
   */
  const checkpoint = async (name = 'mirror') => {
    await mutationChain;

    const rows = await f.storage.list(owner);
    const target = path.join(directory, `${name}.v8`);

    await fs.writeFile(`${target}.tmp`, serialize(rows));
    await fs.rename(`${target}.tmp`, target);

    return { rows, target };
  };
  /**
   * Мутации старого окна сериализуются настоящим IDB adapter и завершаются до ответа child.
   * Network RPC может удерживаться тестом; callback не получает доступа к IDB напрямую.
   */
  const handleRpc = async message => {
    rpcCalls.push({ op: message.op, args: structuredClone(message.args) });

    if (['put', 'remove'].includes(message.op)) {
      const work = mutationChain.then(async () => {
        assert.equal(exited, false, 'Storage RPC не должен появиться из завершённого context');
        await f.storage[message.op](...message.args);
        mutations += 1;
      });

      mutationChain = work;
      await work;
      await checkpoint();

      return;
    }
    if (message.op === 'list') {
      return f.storage.list(...message.args);
    }

    return network(message.op, ...message.args);
  };

  child.on('message', message => {
    if (message.kind === 'ready') {
      ready.resolve();
    }
    else if (message.kind === 'result') {
      commands.get(message.id)?.resolve(message);
      commands.delete(message.id);
    }
    else if (message.kind === 'event') {
      events.push({ event: message.event, data: message.data });
    }
    else if (message.kind === 'rpc') {
      void handleRpc(message).then(data => reply({
        kind: 'rpc-result',
        id: message.id,
        data,
      }), cause => reply({
        kind: 'rpc-result',
        id: message.id,
        error: {
          message: cause.message,
          status: cause.status,
          code: cause.code,
          body: cause.body,
        },
      }));
    }
  });
  /**
   * Только собственный child получает bounded shutdown; потеря context не оставляет фонового исполнителя.
   * При timeout graceful close считается ошибкой даже после принудительной уборки child.
   */
  const awaitExit = async (limit = 2000) => {
    let timer;

    try {
      return await Promise.race([exit.promise, new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('Старое окно не завершилось в отведённый срок.'));
        }, limit);
      })]);
    } finally {
      clearTimeout(timer);
    }
  };

  t.after(async () => {
    if (!exited) {
      child.kill('SIGKILL');
      await awaitExit();
    }
  });
  child.send({
    kind: 'init',
    owner,
    libraryId,
  });

  const readyTimeout = setTimeout(() => ready.reject(new Error('Старое окно не подтвердило ready.')), 5000);

  try {
    await Promise.race([ready.promise, exit.promise.then(value => {
      throw new Error(`Старое окно завершилось до ready: ${JSON.stringify(value)} ${stderr}`);
    })]);
  } finally {
    clearTimeout(readyTimeout);
  }

  /**
   * Команда содержит отдельный id, чтобы abort и held submit не перепутали ответы.
   * Exit завершает ожидающие команды явным context_closed без запуска старого callback.
   */
  const command = (kind, extra = {}) => {
    assert.equal(exited, false);

    const id = ++sequence;
    const result = Promise.withResolvers();

    commands.set(id, result);
    child.send({
      kind,
      id,
      ...extra,
    });

    return result.promise;
  };
  /**
   * Успех требует настоящего child exit0 до replacement, а не только abort поколения.
   * Bounded timeout завершает лишь этот fixture child и оставляет тест красным.
   */
  const close = async () => {
    if (!exited) {
      child.send({ kind: 'shutdown' });
    }

    const result = await awaitExit();

    assert.deepEqual(result, { code: 0, signal: null }, stderr);
    await mutationChain;

    return result;
  };

  return {
    directory,
    child,
    events,
    rpcCalls,
    command,
    close,
    checkpoint,
    exited: () => exited,
    mutationCount: () => mutations,
    suppressedReplies: () => suppressedReplies,
  };
}
