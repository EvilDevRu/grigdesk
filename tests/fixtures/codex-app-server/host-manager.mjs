import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const RUN_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const state = path.join(path.dirname(process.argv[1]), 'state');
const args = process.argv.slice(2);
const unit = args.find((value) => value.startsWith('--unit=')).slice(7);
const commandAt = args.indexOf('--');
const child = spawn(args[commandAt + 1], args.slice(commandAt + 2), { stdio: 'inherit' });

fs.appendFileSync(path.join(state, 'journal.jsonl'), JSON.stringify({ op: 'run', unit, args }) + '\\n');
fs.writeFileSync(path.join(state, unit), JSON.stringify({ pid: child.pid }));
child.on('exit', () => process.exit(0));
process.on('SIGTERM', () => child.kill('SIGTERM'));
`;

const CTL_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const state = path.join(path.dirname(process.argv[1]), 'state');
const args = process.argv.slice(2);
const op = args[1];

if (op === 'show-environment') {
  process.exit(0);
}

const unit = op === 'kill' ? args.at(-1) : args[2];
const file = path.join(state, unit);
const ownGroup = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\\n')
  .find((line) => line.startsWith('0::')).slice(3);
const ownUnit = ownGroup.split('/').at(-1);

fs.appendFileSync(path.join(state, 'journal.jsonl'), JSON.stringify({ op, unit }) + '\\n');

if (op === 'show') {
  process.stdout.write(unit === ownUnit
    ? 'LoadState=loaded\\nActiveState=active\\nControlGroup=' + ownGroup + '\\n'
    : fs.existsSync(file)
    ? 'LoadState=loaded\\nActiveState=active\\nControlGroup=/synthetic/' + unit + '\\n'
    : 'LoadState=not-found\\nActiveState=inactive\\nControlGroup=\\n');
} else if (op === 'stop' || op === 'kill') {
  if (fs.existsSync(path.join(state, 'hang-close'))) {
    setTimeout(() => process.exit(1), 15000);

    return;
  }

  if (fs.existsSync(path.join(state, 'fail-close'))) {
    process.stderr.write('Синтетический отказ менеджера\\n');
    process.exit(1);
  }

  if (fs.existsSync(file)) {
    const { pid } = JSON.parse(fs.readFileSync(file, 'utf8'));

    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw error;
      }
    }

    fs.unlinkSync(file);
  }
}
`;

/**
 * Двойник сохраняет owner после exit CLI, пока не подтверждён stop того же UUID.
 * Это протокольная проверка учёта; принадлежность настоящей cgroup доказывает native suite.
 */
export async function hostManager(t, root, register = (close) => t.after(close)) {
  const directory = path.join(root, 'manager');
  const state = path.join(directory, 'state');
  const journal = path.join(state, 'journal.jsonl');
  const run = path.join(directory, 'systemd-run');
  const ctl = path.join(directory, 'systemctl');
  const names = {
    GRIGDESK_CODEX_SYSTEMD_RUN_BIN: run,
    GRIGDESK_CODEX_SYSTEMCTL_BIN: ctl,
  };
  const previous = Object.fromEntries(Object.keys(names).map((key) => [key, process.env[key]]));

  await mkdir(state, { recursive: true });
  await writeFile(journal, '');
  await writeFile(run, RUN_SOURCE, { mode: 0o755 });
  await writeFile(ctl, CTL_SOURCE, { mode: 0o755 });
  Object.assign(process.env, names);
  register(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  return {
    state,
    async journal(op) {
      return (await readFile(journal, 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
        .filter((entry) => !op || entry.op === op);
    },
    async fail() {
      await writeFile(path.join(state, 'fail-close'), '1');
    },
    async heal() {
      const { rm } = await import('node:fs/promises');

      await rm(path.join(state, 'fail-close'), { force: true });
      await rm(path.join(state, 'hang-close'), { force: true });
    },
    async timeout() {
      await writeFile(path.join(state, 'hang-close'), '1');
    },
  };
}
