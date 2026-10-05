# Настройки роняют вкладку headless-проверки = нужен полный Chromium

`chromium.launch({ headless: true })` из `playwright-core` по умолчанию берёт
`chrome-headless-shell`. Раздел «Настройки» в нём падает примерно через полсекунды после
открытия: `page.goto` проходит, а следующий вызов получает `Page crashed`. Доска и конвейер
открываются, поэтому падение легко принять за дефект новой сборки.

Причина видна только в журнале самого браузера (`args: ['--enable-logging=stderr']`):

```text
Terminating render process for bad Mojo message: Received bad user message:
No binder found for interface media.mojom.OnDeviceSpeechRecognition
```

Страница проверяет локальное распознавание речи (`SpeechRecognition.available()`), а у
`chrome-headless-shell` нет этой службы, и браузер убивает рендерер. Код кокпита ни при чём.

Для живого осмотра настроек запускай полный Chromium той же ревизии:
`chromium.launch({ headless: true, channel: 'chromium' })`.
