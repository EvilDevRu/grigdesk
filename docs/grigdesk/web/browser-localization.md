# Локализация браузера и данные протокола

Подписи трёх полей browser-настроек и их подсказки находятся в RU/EN settings-каталогах.
Catalog проецирует их через labelKey/hintKey. Для вычисляемых ключей i18n-scope.json
содержит точные списки browserOpen/browserApplication/browserAgents и соответствующих
Hint: сторож проверяет существование каждого ключа в зарегистрированных локалях.

browser_unavailable в native IPC и browser_preferences_ack_invalid в staged adapter —
коды протокола, сохраняющие смысл для вызывающего кода. Они зарегистрированы как
technicalTokens только для своих файлов с причиной, а не превращены в переводимые ID.
Product router берёт переводчик из публичного ui.ts, как остальные UI-потребители.
