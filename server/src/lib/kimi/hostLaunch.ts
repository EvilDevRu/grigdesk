// Host-запуск kimi-чатов (режим kimiLaunchMode=host): прямой дочерний процесс сервера,
// parity с executors/claude.js. Никаких namespace/cgroup/egress allowlist: доступ к файлам
// и сети ограничивает собственная permission-система Kimi (ACP default/plan + промпты в UI),
// а не mount namespace. Контраст с contained-профилем описан в
// docs/cockpit/kimi-runtime-security.md.
import {
  assertExecutable,
  assertPrivateCredentialDir,
  canonicalDirectory,
} from './sandbox.ts';

/**
 * Строит запуск `kimi acp` на хосте. env — caller-env от chat-модуля (тот же, что
 * получает claude: baseEnv сервера + служебные переменные хода); добавляем только
 * адресные переменные самого Kimi. Proxy-переменные не ставим: сеть прямая.
 */
export async function buildKimiHostLaunch({ config, cwd, env }: {
  config: { kimiBin?: unknown; kimiHome?: unknown };
  cwd: unknown;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwdReal: string;
  unit: null;
}> {
  const cwdReal = await canonicalDirectory(cwd, 'kimi_cwd');
  const kimiBin = await assertExecutable(config.kimiBin, 'kimi_bin_invalid');
  // Тот же контракт credentials, что в contained: файл существует и закрыт (0600).
  await assertPrivateCredentialDir(config.kimiHome);
  return {
    command: kimiBin,
    args: ['acp'],
    env: {
      ...env,
      KIMI_CODE_HOME: String(config.kimiHome),
      // Cron чат-сессий не должен всплывать в интерактивных сессиях пользователя
      // того же KIMI_CODE_HOME; в contained он выключен тем же способом.
      KIMI_DISABLE_CRON: '1',
    },
    cwdReal,
    // Маркер отсутствия systemd-юнита: runtime по нему отличает host от contained.
    unit: null,
  };
}
