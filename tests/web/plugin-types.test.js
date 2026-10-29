import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { validatePluginPackage } from '../../server/src/lib/pluginInstall/validatePackage.ts';
import { runtimeFixture } from '../server/helpers/pluginRuntimeFixture.js';
import {
  builtPackage, command, compileConsumer, compileSourceContract, consumer,
  expectTypeFailure, filesUnder, sourceRoot, ts, uiQuickInfo,
} from './helpers/pluginTypes.mjs';

const requireWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const semver = requireWeb('semver');
const serverConsumer = `
import type { PluginManifest, InstallablePluginManifest } from '@grigdesk/plugin-types';
import type { PluginServerAsync, PluginServerCallback, PluginServerOptions }
  from '@grigdesk/plugin-types/server';
import type { FastifyRequest } from 'fastify';
const manifest: PluginManifest = {
  id: 'consumer', api: 2, nav: { path: '/ext/consumer', group: 'rail' },
  settings: [{ key: 'greeting', type: 'string', default: 'Привет' }],
  placements: [{ slot: 'chat.sidebar', default: true }],
  webModule: { dir: 'ui', entry: 'panel.js', css: ['panel.css'],
    locales: { ru: 'ru.json', en: 'en.json' }, startOnLogin: true },
  install: { npm: [] }, minGrigDeskVersion: '0.1.0',
};
const legacy: PluginManifest = { id: 'legacy', api: 1, web: 'web' };
const installed: InstallablePluginManifest = { ...manifest, version: '1.0.0' };
// @ts-expect-error Допустимы только API 1 и 2.
const badApi: PluginManifest = { id: 'bad', api: 3 };
// @ts-expect-error Устанавливаемому пакету нужна version.
const badVersion: InstallablePluginManifest = { id: 'bad' };
declare const request: FastifyRequest;
const auth: 'session' | 'internal' | 'cli' | null | undefined = request.authKind;
// @ts-expect-error Прочие декораторы приложения не входят в публичную augmentation.
request.authPrincipal;
const asyncServer: PluginServerAsync = async (app, options) => {
  app.get('/status', async (incoming) => ({ auth: incoming.authKind }));
  options.core.emit('ready', options.plugin.id);
  options.lifecycle.prepareChange = async (change, signal) => {
    signal.throwIfAborted();
    return { commit() {}, rollback: async () => {}, afterCommit: async () => {} };
  };
};
const callbackServer: PluginServerCallback = (app, options, done) => { done(); };
declare const options: PluginServerOptions;
options.prefs.write(null);
const prefs: Record<string, unknown> = options.prefs.read();
// @ts-expect-error Внутреннего config нет.
options.config.prefsPath;
// @ts-expect-error Класс PrefsStore не выдаётся.
options.prefs.readStored();
// @ts-expect-error Бинарник выбирает ядро.
options.core.acquireKernelFileLock({ lockPath: '/unused', binary: 'flock' });
// @ts-expect-error Фабрика ошибок принадлежит ядру.
options.core.acquireKernelFileLock({ lockPath: '/unused', errorFactory: () => new Error() });
declare const handle: Awaited<ReturnType<typeof options.core.acquireKernelFileLock>>;
handle.assertHeld();
handle.assertPathIdentity();
handle.release();
// @ts-expect-error Внутреннего fd нет.
handle.inheritedFd();
// @ts-expect-error Добавлять корни нельзя.
options.core.documents.addRootProvider(() => []);
const roots = await options.core.documents.roots('chat:fixture');
const resolved = await options.core.documents.resolveAbsolute('/fixture/README.md', 'chat:fixture');
const document = await options.core.documents.read({ source: 'grigdesk', path: 'README.md' });
const content: string = document.content;
const resolvedPath: string = resolved.ref.path;
const rootId: string | undefined = roots[0]?.id;
const asset = await options.core.documents.readAsset({ source: 'grigdesk', path: 'image.png' });
const bytes: Buffer = asset.content;
const value: Promise<number> = options.core.withPathLock('key', async () => 42);
const providers = await options.core.getProviders('3d');
for (const provider of providers) {
  const snapshot = provider.snapshot?.();
  if (snapshot) {
    const account: string = snapshot.accountKey;
    // @ts-expect-error Credentials не выходят через snapshot.
    snapshot.credentials;
    provider.isCurrent?.(snapshot);
  }
  provider.balance?.();
  provider.history?.();
  // @ts-expect-error Проверка актуальности требует snapshot.
  provider.isCurrent?.();
}
void [legacy, installed, badApi, badVersion, auth, asyncServer, callbackServer,
  prefs, content, resolvedPath, rootId, bytes, value];
`;
const webConsumer = `
import type { PluginModuleContext, PluginPanelProps, PluginModuleStart, PluginUiModule }
  from '@grigdesk/plugin-types/web';
import * as UI from '@grigdesk/ui';
import type { Component } from 'vue';
declare const context: PluginModuleContext;
const props: PluginPanelProps = { context, active: false, compact: true, presentation: 'hidden' };
context.api.get('/api/status', { signal: context.signal, timeoutMs: 10, retry: false });
context.api.post('/api/status', {}, { idleTimeoutMs: 10 });
context.api.put('/api/status', {});
context.api.patch('/api/status', {});
context.api.del('/api/status', {});
context.t('own.message', { name: 'Автор' }, 'Текст');
const off: () => void = context.events.on('tick', (data) => {}, { lifetime: 'panel' });
context.alerts.show({ id: 'status', title: 'Готово', tone: 'accent', openPanel: false });
context.alerts.dismiss('status');
context.alerts.clear();
const chat: Promise<string> = context.askAgent({
  workdir: { kind: 'grigdesk' }, title: 'Чат', draft: 'Текст',
});
const opened: Promise<boolean> = context.panel.open();
const closed: Promise<boolean> = context.panel.close();
const expanded: boolean = context.panel.setExpanded(true);
// @ts-expect-error Язык readonly.
context.locale.value = 'en';
// @ts-expect-error Настройки readonly.
context.settings.value.greeting = 'Нет';
// @ts-expect-error Срок подписки закрытый.
context.events.on('tick', () => {}, { lifetime: 'forever' });
// @ts-expect-error Тон закрытый.
context.alerts.show({ id: 'bad', title: 'Ошибка', tone: 'invalid-tone' });
// @ts-expect-error Панель не принимает чужой id.
context.panel.open('other');
// @ts-expect-error API put не принимает options.
context.api.put('/api/status', {}, { signal: context.signal });
// @ts-expect-error Неизвестный режим запрещён.
const badProps: PluginPanelProps = { context, presentation: 'floating' };
declare const component: Component;
const start: PluginModuleStart = async () => () => {};
const module: PluginUiModule = { default: component, start };
const buttonProps: InstanceType<typeof UI.UiButton>['$props'] = {
  tone: 'neutral', onClick: (event: MouseEvent) => event.preventDefault(),
};
// @ts-expect-error Неверный prop не теряется в DefineComponent<any>.
const badTone: InstanceType<typeof UI.UiButton>['$props'] = { tone: 'invalid-tone' };
// @ts-expect-error Событие click передаёт MouseEvent.
const badEvent: InstanceType<typeof UI.UiButton>['$props'] = { onClick: (value: number) => {} };
declare const button: InstanceType<typeof UI.UiButton>;
button.$emit('click', new MouseEvent('click'));
// @ts-expect-error Event не содержит полей MouseEvent.
button.$emit('click', new Event('click'));
button.$slots.leading?.();
// @ts-expect-error leading не принимает параметров.
button.$slots.leading?.(42);
UI.t('core.loading');
// @ts-expect-error Переводчик ядра сохраняет союз ключей.
UI.t('author.notInCore');
void [props, off, chat, opened, closed, expanded, badProps, module, buttonProps, badTone, badEvent];
`;
const componentGuards = `
// Обычные SFC предоставляют экземпляр, generic SFC — props и контекст вызова.
// Оба пути проверяют настоящие поля декларации, не подменяя отсутствующее поле заглушкой.
type ComponentContract<C> = C extends abstract new (...args: never[]) => infer Instance
  ? Instance
  : C extends (...args: infer Args) => unknown
    ? {
      $props: Args[0];
      $emit: NonNullable<Args[1]> extends { emit: infer Emit } ? Emit : never;
      $slots: NonNullable<Args[1]> extends { slots: infer Slots } ? Slots : never;
    }
    : never;
type IsAny<T> = 0 extends (1 & T) ? true : false;
type IsTyped<T> = IsAny<T> extends true ? false : [T] extends [never] ? false : true;
type Typed<T extends true> = T;
`;

/**
 * AST проверяет замкнутость файловых ссылок, а не слова в словарях переводов.
 * Имена внутренних классов проверяются только в декларациях, JSON не сканируется на credentials.
 */
async function assertDeclarationClosure(directory) {
  const files = await filesUnder(directory);
  const declarations = files.filter((file) => file.endsWith('.d.ts'));

  assert.ok(declarations.length > 4, 'Нужна полная достижимая closure, а не четыре заглушки');

  for (const file of declarations) {
    const text = await readFile(file, 'utf8');
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    /**
     * Проверяем только узлы типов и импорта, не бизнес-строки и словари.
     * Каждый относительный импорт должен разрешаться внутри передаваемой папки.
     */
    const visit = (node) => {
      if (ts.isIdentifier(node)) {
        assert.ok(!['DocumentReader', 'PrefsStore'].includes(node.text),
          `В пакет попал внутренний тип ${node.text}: ${file}`);
      }
      if (ts.isStringLiteral(node) && (ts.isImportDeclaration(node.parent)
        || ts.isExportDeclaration(node.parent) || ts.isLiteralTypeNode(node.parent)
          && ts.isImportTypeNode(node.parent.parent))) {
        const specifier = node.text;

        assert.doesNotMatch(specifier, /server\/src/);
        assert.equal(path.isAbsolute(specifier), false, `Абсолютная ссылка: ${specifier}`);

        if (specifier.startsWith('.')) {
          const resolved = ts.resolveModuleName(specifier, file, {
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            resolveJsonModule: true,
            allowArbitraryExtensions: true,
          }, ts.sys).resolvedModule;

          assert.ok(resolved, `Неполная closure: ${file} -> ${specifier}`);
          assert.ok(!path.relative(directory, resolved.resolvedFileName).startsWith('..'),
            `Ссылка за пределы пакета: ${file} -> ${specifier}`);
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(ast);
  }
}

test('TSDK-PACKAGE: внешняя команда создаёт переносимые entries и metadata', async (t) => {
  const directory = await builtPackage();
  const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(sourceRoot, 'web/package-lock.json'), 'utf8'));
  const vueVersion = lock.packages['node_modules/vue'].version;
  const fastifyVersion = requireServer('fastify/package.json').version;
  const version = (await readFile(path.join(sourceRoot, 'VERSION'), 'utf8')).trim();

  assert.equal(metadata.name, '@grigdesk/plugin-types');
  assert.equal(metadata.type, 'module');
  assert.equal(metadata.private, true);
  assert.equal(metadata.version, `${version}-api2.1`);
  assert.equal(metadata.peerDependencies.vue, `~${vueVersion}`);
  assert.ok(semver.satisfies(vueVersion, metadata.peerDependencies.vue));
  assert.equal(semver.satisfies(`${semver.major(vueVersion)}.${semver.minor(vueVersion) + 1}.0`,
    metadata.peerDependencies.vue), false);
  assert.ok(semver.satisfies(fastifyVersion, metadata.peerDependencies.fastify));
  assert.equal(metadata.peerDependenciesMeta.fastify.optional, true);

  for (const [key, filename] of [['.', 'index.d.ts'], ['./server', 'server.d.ts'],
    ['./web', 'web.d.ts'], ['./ui', 'ui.d.ts']]) {
    assert.equal(metadata.exports[key].types, `./${filename}`);
    assert.ok((await readFile(path.join(directory, filename), 'utf8')).length > 0);
  }

  await assertDeclarationClosure(directory);

  const project = await consumer(t);
  const internal = ['UiDialogHost', 'UiTooltipHost', 'UiToastHost', 'closeTopLayer',
    'getUiLayerDiagnostics', 'subscribeUiLayerDiagnostics', 'setUiDownloadAdapter', 'setUiLocale',
    'dismissAllToasts', 'dismissToast', 'dismissToastScope', 'listToasts', 'showToast',
    'subscribeToastDismissals', 'subscribeToasts'];
  const hints = await uiQuickInfo(project, [...internal, 'UiButton', 'confirmDialog']);

  for (const { name, tags } of hints) {
    assert.equal(tags.includes('internal'), internal.includes(name),
      `QuickInfo ${name}: ожидалась пометка @internal=${internal.includes(name)}, теги: ${tags}`);
  }
});

test('TSDK-CONSUMER: внешний strict NodeNext и Vue consumer проверяют публичные типы', async (t) => {
  const directory = await consumer(t);
  const server = await compileConsumer(directory, serverConsumer);

  assert.equal(server.code, 0, server.output);

  const canonical = await readFile(path.join(sourceRoot, 'web/src/ui.ts'), 'utf8');
  const ast = ts.createSourceFile('ui.ts', canonical, ts.ScriptTarget.Latest, true);
  const components = ast.statements.filter(ts.isExportDeclaration)
    .filter((node) => node.moduleSpecifier?.text.endsWith('.vue'))
    .flatMap((node) => node.exportClause.elements.map((item) => item.name.text));
  const checks = components.flatMap((name) => ['$props', '$emit', '$slots'].map((field) =>
    `type Check${name}${field.slice(1)} =
      Typed<IsTyped<ComponentContract<typeof UI.${name}>['${field}']>>;`));
  const source = [webConsumer, componentGuards, ...checks].join('\n');
  const web = await compileConsumer(directory, source, { web: true });

  assert.equal(web.code, 0, web.output);
});

test('PUBLIC-SERVER: options/core связаны с публичным контрактом', async (t) => {
  const result = await compileSourceContract(t, 'server', 'pluginPublicServer.mts');

  assert.equal(result.code, 0, result.output);
});

test('PUBLIC-WEB: context/start/presentation связаны с публичными типами', async (t) => {
  const result = await compileSourceContract(t, 'web', 'pluginPublicWeb.ts');

  assert.equal(result.code, 0, result.output);
});

/**
 * Готовый сервер проверяется штатной изолированной фикстурой с auth, SSE и загрузчиком.
 * Путь GET читается из AST самого примера: имя маршрута не становится новым требованием.
 */
async function assertExampleServer(t, payload, manifest) {
  const entries = await filesUnder(payload);
  const files = Object.fromEntries(await Promise.all(entries.map(async (file) => [
    path.relative(payload, file), await readFile(file),
  ])));
  const ast = ts.createSourceFile('server.js', files['server.js'].toString(), ts.ScriptTarget.Latest, true);
  const routes = [];
  /**
   * Пример объявляет простой read-only маршрут литералом в вызове Fastify.get.
   * Ищем только такие вызовы, не смешивая их со статикой модуля и каталогом ядра.
   */
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'get' && node.arguments[0]
      && ts.isStringLiteral(node.arguments[0])) {
      routes.push(node.arguments[0].text);
    }

    ts.forEachChild(node, visit);
  };

  visit(ast);
  assert.ok(routes.length > 0, 'Пример регистрирует read-only GET');

  const fixture = await runtimeFixture(t, [{
    id: manifest.id,
    manifest,
    files,
  }], { sse: true });
  const response = await fixture.request('GET', `/api/ext/${manifest.id}${routes[0]}`);

  assert.equal(response.statusCode, 200, response.body);
}

test('TSDK-EXAMPLE: TS и SFC собираются в payload без dev-инструментов и проходят validator', async (t) => {
  const directory = await consumer(t, { example: true });
  const checked = await command('npm', ['run', 'typecheck'], directory);

  assert.equal(checked.code, 0, checked.output);

  const payload = path.join(directory, 'payload');
  const built = await command('npm', ['run', 'build', '--', '--out-dir', payload], directory);

  assert.equal(built.code, 0, built.output);

  const manifest = JSON.parse(await readFile(path.join(payload, 'plugin.json'), 'utf8'));
  const validation = await validatePluginPackage(payload, {
    version: manifest.version,
    expectedId: manifest.id,
    reservedIds: new Set(['code']),
    grigDeskVersion: (await readFile(path.join(sourceRoot, 'VERSION'), 'utf8')).trim(),
  });
  const files = (await filesUnder(payload)).map((file) => path.relative(payload, file));
  const panel = await readFile(path.join(payload, 'ui/panel.js'), 'utf8');

  assert.deepEqual(validation.npmDirs, []);
  assert.equal(manifest.api, 2);
  assert.deepEqual(manifest.install.npm, []);
  assert.ok(files.includes('server.js') && files.includes('ui/panel.js') && files.includes('ui/panel.css'));
  assert.ok(files.every((file) => !/node_modules|package(?:-lock)?\.json|\.vue$|\.ts$/.test(file)));
  assert.match(panel, /from\s*["']vue["']/);
  assert.match(panel, /from\s*["']@grigdesk\/ui["']/);
  assert.doesNotMatch(panel, /import\s*["'][^"']+\.css["']|@grigdesk\/plugin-types|__VUE_OPTIONS_API__/);
  await assertExampleServer(t, payload, manifest);
});

for (const [label, filename, pattern, replacement, code] of [
  ['BAD-SERVER', 'server.ts', /\.emit\(\s*['"]ready['"]/, '.emit(42', 'TS2345'],
  ['BAD-SFC', 'Panel.vue', /(?:v-bind:|:)?tone="[^"]+"/, 'tone="invalid-tone"', 'TS2322'],
]) {
  test(`TSDK-EXAMPLE-${label}: намеренная ошибка ловится в собственной копии`, async (t) => {
    const directory = await consumer(t, { example: true });
    const baseline = await command('npm', ['run', 'typecheck'], directory);

    assert.equal(baseline.code, 0, baseline.output);

    const file = path.join(directory, 'src', filename);
    const source = await readFile(file, 'utf8');

    assert.match(source, pattern, `Нет описанной планом точки мутации в ${filename}`);
    await writeFile(file, source.replace(pattern, replacement));

    const result = await command('npm', ['run', 'typecheck'], directory);

    expectTypeFailure(result, filename, code);
  });
}

test('TSDK-DOCS: рецепт подключения, совместимость и пересборка описаны в документации', async () => {
  const author = await readFile(path.join(sourceRoot, 'plugins/README.md'), 'utf8');
  const modules = await readFile(path.join(sourceRoot, 'docs/grigdesk/plugins/plugin-ui-modules.md'), 'utf8');

  for (const text of [author, modules]) {
    assert.doesNotMatch(text, /пакет типов не предоставляется/i);
    assert.match(text, /@grigdesk\/plugin-types/);
    assert.match(text, /plugin-types\.md/);
  }

  const contract = await readFile(path.join(sourceRoot, 'docs/grigdesk/plugins/plugin-types.md'), 'utf8');
  const index = await readFile(path.join(sourceRoot, 'docs/grigdesk/plugins/README.md'), 'utf8');

  assert.match(index, /\]\(plugin-types\.md\)/);

  for (const pattern of [/build:plugin-types/, /--out-dir/, /@grigdesk\/ui/, /import type/,
    /external/, /Vue|vue/, /api2\.N/, /0\.1\.0-api2\.(?:N|1)/,
    /пересоб[а-яё]*[\s\S]{0,250}верс[а-яё]*|верс[а-яё]*[\s\S]{0,250}пересоб[а-яё]*/i]) {
    assert.match(contract, pattern);
  }
});
