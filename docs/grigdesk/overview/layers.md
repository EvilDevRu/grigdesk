# Слои

```
web (Vue SPA / PWA)  ──HTTP/SSE──▶  server (Fastify, :8140, только 127.0.0.1)  ──▶  источники
                                     │
   Pinia stores                      ├─ adapters/factory-state ─▶ ~/.factory/state
   (chat, tasks, providers,          ├─ engine/bin/factory* ────▶ engine + CLI runners
    plugins, auth, system…)          ├─ adapters/b24 ────────────▶ B24Client (портал)
                                     ├─ adapters/system ───────▶ /proc/meminfo, os.cpus
                                     └─ SpeechRuntime/media ───▶ ffmpeg + local python whisper
```

`*` — встроенный путь по умолчанию; внешний engine возможен только через явный config/env.

Сервер — **host-native** (см. [эксплуатационные грабли](../server/host-native-runtime.md)). Окна (браузер) ходят
на свой origin. Реалтайм — SSE (`/api/events`), `fs.watch` на `~/.factory/state`.

Речь имеет один серверный lifecycle: `server/src/app.ts` создаёт `SpeechRuntime` и инъецирует его в
chat/media/settings. Runtime разрешает валидированный preset в полный immutable job,
задаёт каждому Python-процессу собственный `HF_HOME`, проверяет pinned snapshot без сети
и закрывается вместе с Fastify. Тот же runtime владеет model-job coordinator и при каждом
capability read подбирает завершившиеся detached jobs, поэтому chat, settings и media doctor
видят один cache state. Настройки лежат в prefs, но model-job progress — в отдельных
атомарных status-файлах 0600 внутри каталога 0700: частые обновления загрузки не
переписывают prefs. Restart recovery удерживает dedupe до подтверждённой смерти прежнего
worker по полной process identity.

Источник до переноса: docs/grigdesk/architecture.md § Слои
