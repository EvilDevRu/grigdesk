# Пакет типов пользовательского плагина

`@grigdesk/plugin-types` описывает существующие API плагина и полный фасад `@grigdesk/ui`.
Пакет предназначен только для разработки: содержит декларации `.d.ts`, необходимые JSON
каталогов и package.json, без реализации ядра. В npm эта команда ничего не публикует.

## Получение и подключение

В checkout GrigDesk выполните:

```sh
npm --prefix web run build:plugin-types -- --out-dir /absolute/path/to/sdk
```

Путь обязателен, находится вне дерева исходников; папка должна быть пустой.
Сборщик определяет корень по собственному файлу, поэтому команда работает из другого cwd.
Готовую папку передают автору отдельно. В dev-проекте подключите её как devDependency:

```sh
npm install --save-dev /absolute/path/to/sdk
```

Корневой вход экспортирует только типы манифеста и общих DTO. Серверный вход не требует Vue,
а оконный вход описывает контекст и props панели. Все импорты контракта — `import type`:

```ts
import type { PluginManifest } from '@grigdesk/plugin-types';
import type { PluginServerAsync } from '@grigdesk/plugin-types/server';
import type { PluginPanelProps } from '@grigdesk/plugin-types/web';
import { UiButton } from '@grigdesk/ui';
```

Bare-имя `@grigdesk/ui` при исполнении разрешает карта модулей окна. Только для проверки
типов добавьте в tsconfig dev-проекта:

```json
{
  "compilerOptions": {
    "strict": true,
    "skipLibCheck": false,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "paths": {
      "@grigdesk/ui": ["./node_modules/@grigdesk/plugin-types/ui.d.ts"]
    }
  }
}
```

Сервер использует NodeNext, Fastify 5 и `@types/node`. Fastify — необязательный peer пакета
для автора, которому нужен только UI. Для сборки SFC нужны Vue, vue-tsc и сборщик автора.
Vue и `@grigdesk/ui` оставляются **external**, а CSS выпускается отдельным файлом.
Runtime template compiler не предоставляется.

## Границы контракта

- `PluginManifest` — входной plugin.json: api=1, обязательные description/icon,
  относительные entrypoints, декларации contributes, gallery, install.npm и engines.grigdesk. Scanner допускает
  пропуск version; `InstallablePluginManifest` требует version для установки.
- `PluginMetadata` в options.plugin — нормализованный результат: заполненные поля,
  абсолютный каталог сервера и URL ресурсов. HTTP DTO `PluginWebModule` содержит URL
  entry/css/locales, без серверного каталога. Эти формы нельзя подменять друг другом.
- `PluginServerAsync` и `PluginServerCallback` описывают оба прежних способа регистрации,
  mutable lifecycle, prepareChange и transition. Request augmentation добавляет только
  необязательный `authKind`; прочие декораторы ядра не являются публичными типами.
- Расширение core описывает проекты, песочницы, lease, чтение исходников,
  mkdir-lock, канонический digest и model-only вызов с квитанцией. Методы необязательны
  для проверки возможностей старого сервера; `hostServices` не объявляется. Подробности —
  [серверные сервисы](plugin-core-runtime.md).
- Core описан структурными портами: исполнители без credentials, события, очередь,
  kernel lock без выбора бинарника/фабрики ошибок/дескриптора, Range, чтение документов.
  Полного config, классов чтения документов и PrefsStore в пакете нет. Config содержит
  только пути пользовательских плагинов, prefs — read/write. `dataDir` необязателен,
  как в рантайме при отсутствии настроенного корня данных плагинов.
- `PluginModuleContext` включает все существующие услуги окна: api, readonly locale и
  settings, t, signal, events, alerts, askAgent и свою panel. Router, dock, chat store и
  проверка живого владельца остаются внутри окна. `PluginUiModule` описывает default
  компонент и необязательный named start с cleanup; `PluginPanelProps` — context,
  active/compact и presentation (`page`, `dock`, `hidden`, `placeholder`).
- UI-декларации получаются из единственной границы ui.ts и SFC: сохраняют props, события,
  слоты и типы сервисов. Hosts диалогов/тостов/подсказок, диагностика и закрытие слоёв,
  установка языка/адаптера скачивания и raw toast-функции помечены `@internal`.
  Сборщик ставит тег на объявления в готовом пакете, чтобы он был виден в подсказке
  редактора; подробности — [подготовка деклараций](plugin-types-declarations.md).
  Они доступны для совместимости, их подсказки не разрешают создавать свои hosts.
  Переводчик UI `t` сохраняет ключи каталогов ядра; свои ключи переводят через context.t.

## Совместимость и пример

Папка является снимком версии GrigDesk: её нужно **пересобирать к каждой версии GrigDesk**,
а автору — обновлять подключённую копию. Версия пакета равна VERSION приложения,
metadata также содержит grigDeskVersion. Поколение манифеста api=1 не является
версией SDK и не выбирает способ панели или доступ к серверным сервисам.

Peer Vue вычисляется из web/package-lock.json как `~<текущая версия>`: допускает patch
той же minor, исключает следующую minor. После обновления Vue папку также пересобирают.
Состав runtime-фасадов и карты модулей пакет не меняет.

Собираемый [пример TS и Vue SFC](../../../packages/plugin-types/example/README.md) содержит
сервер, панель, собственные конфигурации typecheck и build. Команда typecheck проверяет
его против готового пакета; неверные core.emit или tone отклоняются. Build создаёт
отдельный payload с plugin.json, server.js и ui/panel.js + panel.css.

Dev-проект с локальным SDK не устанавливается как плагин. Передаётся только payload,
без package.json инструментов, SDK, node_modules и исходных TS/SFC; `install.npm: []`
не запускает npm-подготовку. Проверка зависимостей установщика не ослаблена: file:, URL
архивов и workspace в устанавливаемом плагине остаются запрещены, включая devDependencies.

Единственный исполняемый контракт — v1. Обновление сервера и окон описано в
[модульных панелях](plugin-ui-modules.md), услуги — в [контексте](plugin-module-services.md).
