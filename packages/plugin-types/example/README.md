# Пример плагина на TypeScript и Vue

Скопируйте этот dev-проект за пределы GrigDesk, а готовую папку типов — рядом с ним
под именем `sdk`. Подключение `file:../sdk` используется только при разработке.

```sh
npm install
npm run typecheck
npm run build -- --out-dir /absolute/path/to/payload
```

Устанавливается только `payload`: `plugin.json`, `server.js` и `ui/`.
В нём нет package.json, SDK, node_modules или исходников. Vue и `@grigdesk/ui` оставлены
external: их предоставляет окно. Типы подключаются только через `import type`.

Неверный аргумент `core.emit` в сервере и неверный `tone` в Panel.vue отклоняет typecheck.
Совместимость и получение SDK описаны в [контракте пакета](../../../docs/grigdesk/plugins/plugin-types.md).
