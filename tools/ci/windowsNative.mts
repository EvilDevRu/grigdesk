import { execFile, spawn } from 'node:child_process';
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { sha256, sha256File } from '../../shared/node/hash.ts';
import { RELEASE_SIGNING_PUBLIC_KEY } from '../../shared/runtime/releaseChannelContracts.ts';
import { readStableReleasePlan } from '../stableReleasePlan.mts';

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '../..');
const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const archiveNames = ['grigdesk-maintenance.exe', 'desktop.exe', 'server.zip'] as const;
const script = 'grigdesk-install.ps1';
const release = 'release.json';
const windowsFiles = [script, `${script}.sha256`, `${script}.sig`, archiveNames[0], release,
  archiveNames[1], archiveNames[2]] as const;

export type WindowsTarget = 'windows-x64' | 'windows-arm64';
type Plan = Awaited<ReturnType<typeof readStableReleasePlan>>;

interface WindowsInputs {
  target: WindowsTarget;
  plan: Plan;
  planDigest: string;
}

/**
 * Опись Windows считает файлы потоком и согласует предел с распаковщиком.
 * Ссылки и пустые файлы не входят в подписанный пакет.
 */
async function publicReleaseFile(directory: string, name: string) {
  const file = path.join(directory, name);
  const stat = await fs.lstat(file);

  if (!stat.isFile() || stat.size < 1 || stat.size > 768 * 1024 * 1024) {
    throw new Error(`windows_release_file_invalid: ${name}`);
  }

  return {
    name,
    size: stat.size,
    sha256: await sha256File(file),
  };
}

/**
 * Стабильные команды используют один план и запускаются на архитектуре пакета.
 * Неподключённые платформы сохраняют отдельный диагноз.
 */
export async function windowsStableInputs(target: string | undefined, file: string | undefined):
Promise<WindowsInputs> {
  if (target !== 'windows-x64' && target !== 'windows-arm64') {
    throw new Error(`stable_native_adapter_missing (${target})`);
  }
  if (!file || process.platform !== 'win32' || target !== `windows-${process.arch}`) {
    throw new Error('windows_native_runner_mismatch');
  }

  const planDigest = process.env.STABLE_PLAN_SHA256 ?? '';
  const plan = await readStableReleasePlan(file, {
    commit: process.env.GITHUB_SHA ?? '',
    runId: process.env.GITHUB_RUN_ID ?? '',
    digest: planDigest,
  });

  return {
    target,
    plan,
    planDigest,
  };
}

/**
 * На сборочных шагах зависимости, go и electron-builder получают обычное окружение.
 * Ключ нужен только коду, который запечатывает опись и bootstrap.
 */
function buildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };

  delete env.RELEASE_SIGNING_KEY;

  return env;
}

/**
 * Принимает оба используемых CI представления PEM и сверяет его с публичным ключом выпуска.
 * Fixture передаёт свой ключ непосредственно в сборщик тестового пакета.
 */
export function productionWindowsKey(): KeyObject {
  const value = process.env.RELEASE_SIGNING_KEY?.trim() ?? '';
  const pem = value.startsWith('-----BEGIN ') ? value : Buffer.from(value, 'base64').toString('utf8');
  const key = createPrivateKey(pem);

  if (!publicDer(createPublicKey(key)).equals(publicDer(createPublicKey(RELEASE_SIGNING_PUBLIC_KEY)))) {
    throw new Error('windows_release_signing_key_mismatch');
  }

  return key;
}

function publicDer(key: KeyObject): Buffer {
  return key.export({ type: 'spki', format: 'der' });
}

/**
 * PE-проверка отличает исполняемый файл от пакета другой архитектуры.
 * NSIS bootstrap может быть 32-битным, здесь проверяются только Node, Go и установленное окно.
 */
export async function assertWindowsMachine(file: string, target: WindowsTarget): Promise<void> {
  const handle = await fs.open(file, 'r');

  try {
    const dos = Buffer.alloc(64);
    const pe = Buffer.alloc(6);

    if ((await handle.read(dos, 0, dos.length, 0)).bytesRead !== dos.length
      || dos.readUInt16LE(0) !== 0x5a4d
      || (await handle.read(pe, 0, pe.length, dos.readUInt32LE(0x3c))).bytesRead !== pe.length
      || pe.readUInt32LE(0) !== 0x4550
      || pe.readUInt16LE(4) !== (target === 'windows-x64' ? 0x8664 : 0xaa64)) {
      throw new Error(`windows_executable_arch_invalid: ${path.basename(file)}`);
    }
  } finally {
    await handle.close();
  }
}

/**
 * Сервер получает ровно ресурсы исходного Node-входа и production-зависимости.
 * Runtime распространяется внутри ZIP, системный Node при установке не нужен.
 */
async function stageServer(root: string, target: WindowsTarget, plan: Plan, env: NodeJS.ProcessEnv): Promise<void> {
  const files = ['server/src', 'server/seed', 'server/build',
    'server/deepseek-runtime-contract.json', 'server/deepseek-host-contract.json',
    'server/package.json', 'server/package-lock.json', 'shared', 'cli/darwinBuildProcesses.ts',
    'deploy', 'docs/grigdesk/guide',
    'docs/engine', 'docs/README.md', 'server/requirements-media.txt', 'VERSION'];
  const runtime = path.join(root, 'runtime');

  await fs.mkdir(runtime, { recursive: true });
  await fs.mkdir(path.join(root, 'bin'));

  for (const name of files) {
    const targetPath = path.join(root, name);

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.cp(path.join(repository, name), targetPath, { recursive: true, errorOnExist: true });
  }

  const node = path.join(runtime, 'node.exe');
  const factory = path.join(root, 'bin', 'factory.exe');
  const pin = JSON.parse(await fs.readFile(path.join(root, 'server/build/node-runtime.json'), 'utf8'));

  if (pin.version !== process.versions.node) {
    throw new Error('windows_node_version_mismatch');
  }

  await fs.copyFile(process.execPath, node);
  await assertWindowsMachine(node, target);
  await execute(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: path.join(root, 'server'),
    env,
    timeout: 300_000,
  });
  await execute('go', [
    'build', '-trimpath', '-buildvcs=false', '-o', factory, './utilities/factory/cmd/factory',
  ], {
    cwd: repository,
    env,
    timeout: 300_000,
  });
  await assertWindowsMachine(factory, target);
  await fs.writeFile(path.join(root, 'grigdesk-windows.json'), '{"format":1}\n');
  await fs.writeFile(path.join(root, release), JSON.stringify({
    schema: 1,
    packagingVersion: 1,
    version: plan.current.version,
    contentId: sha256(Buffer.from(`${plan.current.releaseId}/${target}`)),
  }) + '\n');
}

/**
 * Архив содержит обычные файлы с относительными путями, которые понимает Go unzip.
 * Временный ZIP не использует путь текущего checkout внутри поставки.
 */
async function archiveServer(root: string, output: string): Promise<void> {
  const require = createRequire(path.join(repository, 'server/package.json'));
  const { zipSync } = require('fflate') as typeof import('../../server/node_modules/fflate/lib/index.d.ts');
  const files: Record<string, Uint8Array> = Object.create(null);

  for (const name of await fs.readdir(root, { recursive: true })) {
    const file = path.join(root, name);
    const info = await fs.lstat(file);

    if (info.isFile()) {
      files[name.split(path.sep).join('/')] = await fs.readFile(file);
    } else if (!info.isDirectory()) {
      throw new Error('windows_server_archive_input_invalid');
    }
  }

  await fs.writeFile(output, zipSync(files, { level: 3 }), { flag: 'wx' });
}

/**
 * Сборщик берёт Electron и npm из закреплённых зависимостей checkout.
 * NSIS устанавливает только окно, поэтому сам не открывает его до готовности сервера.
 */
async function buildWindow(output: string, target: WindowsTarget, plan: Plan, env: NodeJS.ProcessEnv) {
  const desktop = path.join(repository, 'desktop');
  const desktopEnv = {
    ...env,
    GRIGDESK_RELEASE_VERSION: plan.current.version,
    GRIGDESK_RELEASE_CHANNEL: plan.current.channel,
    GRIGDESK_RELEASE_COMMIT: plan.current.commit,
    GRIGDESK_RELEASE_ID: plan.current.releaseId,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  };

  await execute(process.execPath, [path.join(desktop, 'scripts/build.mts')], {
    cwd: desktop,
    env: desktopEnv,
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  await execute(process.execPath, [
    path.join(desktop, 'node_modules/electron-builder/out/cli/cli.js'),
    '--win', 'nsis', `--${target.slice('windows-'.length)}`, '--publish', 'never',
    `--config.directories.output=${output}`, '--config.artifactName=desktop.exe',
    `--config.extraMetadata.version=${plan.current.version}`, '--config.nsis.runAfterFinish=false',
    '--config.nsis.guid=73fd52cc-055b-5e49-89e0-9706aab795e4',
    // 7z-ветка NSIS оставляла поставку ARM64 без EXE и DLL. ZIP распаковывается сразу в каталог программы.
    ...(target === 'windows-arm64' ? ['--config.nsis.useZip=true', '--config.nsis.differentialPackage=false'] : []),
  ], {
    cwd: desktop,
    env: desktopEnv,
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

/**
 * Пакет Windows фиксирует байты трёх компонентов и точную release identity.
 * Bootstrap закрепляет SHA помощника перед запуском, помощник проверяет подпись описи.
 */
export async function buildWindowsNative(
  target: WindowsTarget, plan: Plan, output: string, key: KeyObject,
): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...buildEnv(),
    GOOS: 'windows',
    GOARCH: target === 'windows-x64' ? 'amd64' : 'arm64',
    GOTOOLCHAIN: 'local',
    GOWORK: 'off',
    GOFLAGS: '',
    CGO_ENABLED: '0',
  };
  const go = await execute('go', ['version'], { env });

  if (!go.stdout.startsWith('go version go1.27.4 ') || key.asymmetricKeyType !== 'ed25519') {
    throw new Error('windows_release_toolchain_invalid');
  }

  await fs.mkdir(output);

  const work = await fs.mkdtemp(path.join(path.dirname(output), '.windows-build-'));

  try {
    const server = path.join(work, 'server');
    const window = path.join(work, 'window');
    const helper = path.join(output, archiveNames[0]);
    const trust = publicDer(createPublicKey(key)).toString('base64');

    await stageServer(server, target, plan, env);
    await archiveServer(server, path.join(output, 'server.zip'));
    await buildWindow(window, target, plan, env);
    await fs.copyFile(path.join(window, 'desktop.exe'), path.join(output, 'desktop.exe'));
    await execute('go', ['build', '-trimpath', '-buildvcs=false', '-ldflags',
      `-s -w -X main.version=${plan.current.version} -X main.windowsReleaseKey=${trust}`,
      '-o', helper, './utilities/maintenance/cmd/maintenance'], {
      cwd: repository,
      env,
      timeout: 300_000,
    });
    await assertWindowsMachine(helper, target);

    const files = await Promise.all(archiveNames.map((name) => publicReleaseFile(output, name)));
    const payload = Buffer.from(JSON.stringify({
      format: 1,
      platform: target,
      ...plan.current,
      runId: plan.runId,
      files,
    }));
    const manifest = JSON.stringify({
      payload: payload.toString('base64'),
      signature: sign(null, payload, key).toString('base64'),
    }) + '\n';

    await fs.writeFile(path.join(output, release), manifest, { flag: 'wx' });

    const template = await fs.readFile(path.join(import.meta.dirname, 'installWindows.ps1'), 'utf8');
    const bootstrap = Buffer.from('\ufeff' + template
      .replace('@@ARCH@@', target === 'windows-x64' ? 'AMD64' : 'ARM64')
      .replace('@@HELPER_SHA@@', files[0]!.sha256));
    const checksum = `${sha256(bootstrap)}  ${script}\n`;
    const signature = sign(null, bootstrap, key).toString('base64') + '\n';

    await fs.writeFile(path.join(output, script), bootstrap, { flag: 'wx' });
    await fs.writeFile(path.join(output, `${script}.sha256`), checksum, { flag: 'wx' });
    await fs.writeFile(path.join(output, `${script}.sig`), signature, { flag: 'wx' });
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

/**
 * Проверяет закрытую опись по доверенному ключу и ожидаемому плану.
 * Проверяющий job сравнивает байты скрипта и всех компонентов до установки.
 */
export async function verifyWindowsPackage(
  directory: string, target: WindowsTarget, plan: Plan, key: KeyObject,
) {
  const entries = (await fs.readdir(directory)).sort();

  if (JSON.stringify(entries) !== JSON.stringify([...windowsFiles].sort())) {
    throw new Error('windows_release_inventory_invalid');
  }

  const files = await Promise.all(windowsFiles.map((name) => publicReleaseFile(directory, name)));

  if (files.some((file) => !archiveNames.some((name) => name === file.name) && file.size > 64 * 1024)) {
    throw new Error('windows_release_metadata_too_large');
  }

  const raw = await fs.readFile(path.join(directory, release));
  const envelope = JSON.parse(raw.toString('utf8'));
  const payload = Buffer.from(envelope.payload, 'base64');
  const signature = Buffer.from(envelope.signature, 'base64');

  if (!verify(null, payload, key, signature)) {
    throw new Error('windows_release_signature_invalid');
  }

  const archive = archiveNames.map((name) => files.find((item) => item.name === name));
  const expected = {
    format: 1,
    platform: target,
    ...plan.current,
    runId: plan.runId,
    files: archive,
  };
  const checksum = await fs.readFile(path.join(directory, `${script}.sha256`), 'utf8');
  const scriptProof = await fs.readFile(path.join(directory, `${script}.sig`), 'utf8');
  const bootstrap = await fs.readFile(path.join(directory, script));

  if (JSON.stringify(JSON.parse(payload.toString('utf8'))) !== JSON.stringify(expected)
    || bootstrap.length > 64 * 1024 || checksum !== `${sha256(bootstrap)}  ${script}\n`
    || !verify(null, bootstrap, key, Buffer.from(scriptProof.trim(), 'base64'))) {
    throw new Error('windows_release_package_mismatch');
  }

  await assertWindowsMachine(path.join(directory, archiveNames[0]), target);

  return {
    files,
    manifestDigest: sha256(raw),
    signerFingerprint: sha256(publicDer(key)),
  };
}

/**
 * Резервирует loopback для отдельной приёмки. Рабочие серверы
 * и обычный порт GrigDesk в сценарии не участвуют.
 */
async function privatePort(): Promise<number> {
  const listener = net.createServer();

  listener.listen(0, '127.0.0.1');

  await once(listener, 'listening');

  const address = listener.address();

  listener.close();
  await once(listener, 'close');

  if (!address || typeof address === 'string') {
    throw new Error('windows_verify_port_unavailable');
  }

  return address.port;
}

/**
 * Вызывает обычное системное закрытие именно проверяемого окна.
 * Закрытие считается завершённым после выхода приложения и остановки API.
 */
async function closeWindow(pid: number): Promise<void> {
  const command = `if (-not [Diagnostics.Process]::GetProcessById(${pid}).CloseMainWindow()) {exit 1}`;

  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    timeout: 15000, windowsHide: true,
  });
}

/**
 * Приёмка запускает установленный exe штатным путём. Маркер от Electron
 * появляется только после авторизованной рабочей области, а не при HTTP 200 в API.
 */
export async function verifyFirstLaunch(
  destination: string, work: string, target: WindowsTarget,
): Promise<void> {
  const desktop = path.join(destination, 'grigdesk.exe');
  const factory = path.join(destination, 'server', 'bin', 'factory.exe');
  const node = path.join(destination, 'server', 'runtime', 'node.exe');

  await Promise.all([desktop, factory, node].map((file) => assertWindowsMachine(file, target)));

  const capabilities = await execute(factory, ['capabilities', '--format', 'json'], {
    windowsHide: true, timeout: 15000,
  });

  if (!JSON.parse(capabilities.stdout).features.includes('native-subcommands')) {
    throw new Error('windows_verify_factory_capabilities_missing');
  }

  const port = await privatePort();
  const origin = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GRIGDESK_DESKTOP_DATA_DIR: path.join(work, 'Window Data'),
    GRIGDESK_HOME: path.join(work, 'Server Data'),
    GRIGDESK_PORT: String(port),
    ELECTRON_ENABLE_LOGGING: '1',
  };

  delete env.GRIGDESK_ENV_FILE;

  // Headless CI-раннер может не поддерживать GPU/sandbox Electron; флаги снимают
  // ранний завис до инициализации логирования и запуска локального сервера.
  const child = spawn(desktop, ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  let launchError: Error | undefined;

  child.on('error', (error) => {
    launchError = error;
  });

  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      log = (log + String(chunk)).slice(-64 * 1024);
    });
  }

  // На загруженном CI-раннере первый запуск окна и сервера может занимать
  // несколько минут (антивирус проверяет свежие exe), поэтому запас больше обычного.
  const deadline = Date.now() + 600_000;
  let nextReport = Date.now() + 30_000;

  try {
    while (!log.includes('grigdesk_windows_local_ready')) {
      if (launchError || child.exitCode !== null || Date.now() >= deadline) {
        throw launchError ?? new Error('windows_verify_window_session_not_ready'
          + ` exit=${child.exitCode} signal=${child.signalCode} log=${log.slice(-600)}`);
      }

      if (Date.now() >= nextReport) {
        const api = await fetch(origin + '/api/auth/state', { signal: AbortSignal.timeout(2000) })
          .then((response) => String(response.status)).catch(() => 'no-response');
        const titles = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          "Get-Process grigdesk,electron,node -ErrorAction SilentlyContinue | "
          + 'Select-Object Id,ProcessName,MainWindowTitle | Format-Table -AutoSize | Out-String'],
          { timeout: 10000, windowsHide: true }).then((r) => r.stdout.trim()).catch(() => 'no-titles');

        console.error(`window launch wait: exit=${child.exitCode} api=${api} `
          + `titles=${titles} log=${log.slice(-300)}`);

        const screen = path.join(process.env.LOCALAPPDATA ?? work, 'grigdesk-launch-screen.png')
          .replaceAll("'", "''");

        await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          'Add-Type -AssemblyName System.Windows.Forms,System.Drawing; '
          + '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; '
          + '$img=New-Object System.Drawing.Bitmap $b.Width,$b.Height; '
          + '$g=[System.Drawing.Graphics]::FromImage($img); '
          + '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); '
          + `$img.Save('${screen}'); $g.Dispose(); $img.Dispose()`],
          { timeout: 15000, windowsHide: true }).catch(() => undefined);
        nextReport = Date.now() + 30_000;
      }

      await delay(500);
    }

    const publicState = await fetch(origin + '/api/auth/state', { signal: AbortSignal.timeout(5000) });
    const guarded = await fetch(origin + '/api/projects', { signal: AbortSignal.timeout(5000) });

    await guarded.body?.cancel();

    if (!publicState.ok || !(await publicState.json()).configured || guarded.status !== 401 || !child.pid) {
      throw new Error('windows_verify_window_auth_boundary_invalid');
    }

    await closeWindow(child.pid);

    const stopDeadline = Date.now() + 60_000;

    while (child.exitCode === null && Date.now() < stopDeadline) {
      await delay(500);
    }

    if (child.exitCode !== 0 || await fetch(origin + '/api/auth/state',
      { signal: AbortSignal.timeout(2000) }).then(() => true).catch(() => false)) {
      throw new Error('windows_verify_owned_server_still_running');
    }
  } catch (error) {
    const logPath = path.join(work, 'Server Data', 'state', 'grigdesk-server.log');
    const serverLog = await fs.readFile(logPath, 'utf8').catch(() => '');

    console.error(log.slice(-8000));
    console.error(serverLog.slice(-8000));

    throw error;
  } finally {
    if (child.exitCode === null) {
      child.kill();
    }
  }
}

/**
 * Штатный NSIS-деинсталлятор удаляет весь каталог программы.
 * Проверочная запись остаётся в отдельной папке данных сервера.
 */
export async function verifyUninstall(destination: string, work: string): Promise<void> {
  const data = path.join(work, 'Server Data', 'keep-on-uninstall.txt');

  await fs.writeFile(data, 'grigdesk-install-check\n', { flag: 'wx' });
  await execute(path.join(destination, 'Uninstall GrigDesk.exe'), ['/S'], {
    timeout: 60000, windowsHide: true,
  });

  for (let retry = 0; retry < 60; retry += 1) {
    const installed = await fs.stat(path.join(destination, 'grigdesk.exe')).catch(() => null);
    const runtime = await fs.stat(path.join(destination, 'server')).catch(() => null);

    if (!installed && !runtime && await fs.readFile(data, 'utf8') === 'grigdesk-install-check\n') {
      return;
    }

    await delay(500);
  }

  throw new Error('windows_verify_uninstall_incomplete');
}

/**
 * Подписанный комплект устанавливается из каталога с пробелами в отдельный LocalAppData.
 * Proof публикуется только после выхода окна и подтверждения остановки его сервера.
 */
export async function verifyWindowsNative(
  target: WindowsTarget, plan: Plan, planDigest: string, source: string, output: string,
  key = createPublicKey(RELEASE_SIGNING_PUBLIC_KEY),
): Promise<void> {
  const evidence = await verifyWindowsPackage(source, target, plan, key);
  const local = process.env.LOCALAPPDATA;

  if (!local) {
    throw new Error('windows_verify_localappdata_missing');
  }

  const work = await fs.mkdtemp(path.join(local, 'GrigDesk CI '));

  try {
    const destination = path.join(work, 'GrigDesk Installed');

    await execute('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(source, script), '-Yes', '-InstallDir', destination,
    ], { timeout: 300_000, windowsHide: true });
    await verifyFirstLaunch(destination, work, target);
    await verifyUninstall(destination, work);

    const targetOutput = path.join(output, target);

    await fs.mkdir(targetOutput, { recursive: true });

    for (const file of evidence.files) {
      await fs.copyFile(path.join(source, file.name), path.join(targetOutput, file.name));
    }

    await fs.writeFile(path.join(output, 'stable-native-proof.json'), JSON.stringify({
      format: 1,
      parts: [{
        ...plan.current,
        runId: plan.runId,
        platform: target,
        planDigest,
        ...evidence,
      }],
    }) + '\n', { flag: 'wx' });
  } finally {
    await fs.rm(work, {
      force: true,
      recursive: true,
      maxRetries: 3,
      retryDelay: 500,
    });
  }
}
