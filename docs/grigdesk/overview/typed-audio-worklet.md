# Отдельная среда AudioWorklet

`web/src/shared/speechPcmWorklet.ts` исполняется в host AudioWorklet отдельно от окна.
Его локальные declare описывают настоящий AudioWorkletProcessor, порт, sampleRate
и registerProcessor. Они не подменяют декларациями собственную реализацию приложения.

`web/tsconfig.audioWorklet.json` наследует строгую базу, включает только процессор
и библиотеки ES2022/ES2023.Array без DOM и Node. Общий web-проект также видит этот TS-файл;
`npm --prefix web run typecheck` дополнительно вызывает `typecheck:worklet`.

Транспорт импортирует URL через статический Vite query `?worker&url`, затем передаёт
его прежнему addModule. Vite выпускает отдельный JS asset; браузер не исполняет TS.
Внедряемый workletUrl остаётся строкой или URL. `web/src/shared/speechStream.ts` типизирует транспорт, ресурсы захвата
и проверяемые сообщения WebSocket; процессор остаётся отдельным модулем.

Процессор сохраняет прежние mono mix, линейную интерполяцию, PCM16, кадр 1600 samples
и flush неполного хвоста. После flush PCM больше не выдаётся, выход остаётся немым.
Перенос файлов не меняет владельца MediaStream и полного MediaRecorder.
