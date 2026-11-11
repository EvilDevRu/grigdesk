import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);

if (args[0] === 'check') {
  process.stdout.write(`OK profile=demo catalog=${'b'.repeat(64)} route=feature `
    + 'delivery=disabled instrumentation=disabled\n');
  process.exit(0);
}

if (args[0] === 'slots') {
  process.stdout.write('{"supported":false,"reason":"фикстура без слотов"}\n');
  process.exit(0);
}

const root = process.env.GRIGDESK_HOME;
const registry = fs.readFileSync(path.join(root, 'seed.pipeline'), 'utf8');
const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : '';

fs.writeFileSync(path.join(root, 'state/t7.pipeline'), registry.replace('STALLED_HUMAN=1', 'STALLED_HUMAN=0')
  + `ORCH_PID=${process.pid}\nCATALOG_HASH=${'b'.repeat(64)}\n`
  + `QUEUE_DISPATCH_ID=${value('--queue-dispatch-id')}\n`
  + `RUNNER_OVERRIDE_PRIMARY=${value('--runner-primary')}\n`);
fs.writeFileSync(path.join(root, 'factory-capture.json'), JSON.stringify({
  pid: process.pid,
  argv: args,
  env: {
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    ZAI_API_KEY: process.env.ZAI_API_KEY,
    ZAI_CODING_API_KEY: process.env.ZAI_CODING_API_KEY,
  },
}));
setInterval(() => {}, 1000);
