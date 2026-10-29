import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openCodexSession } from '../../server/src/lib/executors/codex.ts';
import { codexQuestionPresentation, codexQuestionResponse }
  from '../../server/src/lib/executors/_codexQuestions.ts';

const question = {
  id: 'native-id',
  header: 'Тема',
  question: 'Как продолжать?',
  isOther: true,
  isSecret: false,
  options: [{ label: 'Первый', description: 'Выбрать первый' }]
};
const params = {
  threadId: 'thread',
  turnId: 'turn',
  itemId: 'question',
  isBlocking: false,
  autoResolutionMs: 1,
  questions: [question, {
    ...question,
    id: 'second-id',
    options: null
  }]
};

test('native ID разделяет одинаковые header, варианты и текст проверяются сервером', () => {
  const presentation = codexQuestionPresentation(params);

  assert.equal(presentation.blocking, false);
  assert.equal(presentation.questions[0].key, 'native-id');
  assert.deepEqual(codexQuestionResponse(presentation, { action: 'accept', answers: [
    { key: 'native-id', value: 'Свой ответ' }, { key: 'second-id', value: 'Текст' },
  ] }), { answers: { 'native-id': { answers: ['Свой ответ'] }, 'second-id': { answers: ['Текст'] } } });

  const closed = codexQuestionPresentation({ ...params, questions: [{ ...question, isOther: false }] });

  assert.deepEqual(codexQuestionResponse(closed, {
    action: 'accept', answers: [{ key: 'native-id', value: 'Подмена' }],
  }), { answers: {} });
});

test('secret, повторные ID и неизвестная форма отклоняются до presentation', () => {
  for (const questions of [
    [{ ...question, isSecret: true }], [question, question], [{ ...question, id: '' }],
    [{ ...question, options: 'invalid' }],
  ]) {
    assert.equal(codexQuestionPresentation({ ...params, questions }), null);
  }
});

/**
 * Fixture ждёт native result, поэтому завершение доказывает отсутствие зависшего вопроса.
 * В trace остаются только синтетические данные и точный wire-ответ адаптера.
 */
async function fixture(t, questions) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-questions-'));
  const bin = path.join(directory, 'fixture');
  const trace = path.join(directory, 'trace.jsonl');
  const request = { ...params, questions };

  await writeFile(bin, `#!${process.execPath}
const {createInterface}=require('node:readline');
const {appendFileSync}=require('node:fs');
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);appendFileSync(${JSON.stringify(trace)},line+'\\n');
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'thread'},
   approvalPolicy:'on-request',approvalsReviewer:'auto_review',sandbox:{type:'workspaceWrite'}}});
 if(m.method==='turn/start'){
   send({id:m.id,result:{turn:{id:'turn'}}});
   send({id:'native-question',method:'item/tool/requestUserInput',params:${JSON.stringify(request)}});
 }
 if(m.id==='native-question'&&m.result){
   send({method:'item/completed',params:{threadId:'thread',turnId:'turn',
     item:{type:'agentMessage',id:'answer',text:'Ответ получен'}}});
   send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});
 }
});
`);
  await chmod(bin, 0o755);

  const session = openCodexSession({
    config: { codexBin: bin },
    cwd: directory,
    providerSettings: { blockDirectSsh: false },
    tokenInfoReader: async () => null
  });

  t.after(async () => {
    await session.close();
    await rm(directory, { recursive: true, force: true });
  });

  return { session,
    messages: async () => (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse) };
}

test('native вопрос доезжает через общий callback и получает точный response', {
  timeout: 5000,
}, async (t) => {
  const f = await fixture(t, [question]);
  let shown = 0;

  await f.session.send({ message: 'Вопрос', onPermission: (presentation) => {
    shown++;
    assert.equal(presentation.blocking, false);

    return { action: 'accept', answers: [{ key: 'native-id', value: 'Первый' }] };
  } });

  assert.equal(shown, 1);
  assert.deepEqual((await f.messages()).find((message) => message.id === 'native-question').result,
    { answers: { 'native-id': { answers: ['Первый'] } } });
});

test('secret request получает ровно пустой ответ без UI и canary в trace', {
  timeout: 5000,
}, async (t) => {
  const f = await fixture(t, [{ ...question, isSecret: true }]);
  let shown = 0;

  await f.session.send({ message: 'Вопрос', onPermission: () => {
    shown++;

    return { action: 'accept', answers: [{ key: 'native-id', value: 'SECRET_CANARY' }] };
  } });

  const answers = (await f.messages()).filter((message) => message.id === 'native-question');

  assert.equal(shown, 0);
  assert.deepEqual(answers, [{ id: 'native-question', result: { answers: {} } }]);
  assert.doesNotMatch(JSON.stringify(await f.messages()), /SECRET_CANARY/u);
});
