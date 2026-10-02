# Неизменённый legacy updater

`legacy-worker.js` — побайтовая копия исходного installed worker до поддержки
runtime publication. SHA-256:
`7559f158ba3c39cb9c32c26aa29e23944a00a911001c5fb9254be8599f9b3b71`.

Fixture намеренно сохраняет исходные стиль и ошибки старого publisher. Не
форматировать и не исправлять: transition test проверяет переход именно старым
worker, отдельно от текущего production-кода. Все его исполнения ограничены
disposable repositories с fixture restart и собственными prefs/state.
