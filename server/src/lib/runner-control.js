import { execFile } from 'node:child_process';

const TASK_RE = /^\d+$/;
const STAGE_RE = /^[A-Z][A-Z0-9_]*$/;
const PROVIDER_RE = /^[a-z][a-z0-9_-]*$/;

export class RunnerControlInputError extends Error {}
export class RunnerControlCommandError extends Error {}

function defaultRun(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(new RunnerControlCommandError(
          String(stderr || error.message || 'factory runner command failed').trim().slice(-1000),
        ));
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

export class FactoryRunnerControl {
  constructor({
    factoryBin,
    stateDir,
    configRoot,
    profilesDir = '',
    run = defaultRun,
  }) {
    if (!factoryBin || !stateDir || !configRoot) {
      throw new Error('FactoryRunnerControl: factoryBin/stateDir/configRoot are required');
    }
    this.factoryBin = factoryBin;
    this.stateDir = stateDir;
    this.configRoot = configRoot;
    this.profilesDir = profilesDir;
    this.run = run;
  }

  async switch({ task, stage, target }) {
    if (!TASK_RE.test(String(task || ''))
        || !STAGE_RE.test(String(stage || ''))
        || !PROVIDER_RE.test(String(target || ''))) {
      throw new RunnerControlInputError('Некорректные параметры переключения исполнителя.');
    }
    const { stdout } = await this.run(
      this.factoryBin,
      [String(task), 'runner', 'switch', String(stage), String(target)],
      {
        shell: false,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        env: {
          PATH: process.env.PATH || '/usr/bin:/bin',
          HOME: process.env.HOME || '',
          LANG: process.env.LANG || 'C',
          LC_ALL: process.env.LC_ALL || 'C',
          FACTORY_STATE: this.stateDir,
          STATE_DIR: this.stateDir,
          FACTORY_CONFIG_ROOT: this.configRoot,
          ...(this.profilesDir ? { FACTORY_PROFILES_DIR: this.profilesDir } : {}),
        },
      },
    );
    return { ok: true, output: stdout.trim() };
  }
}
