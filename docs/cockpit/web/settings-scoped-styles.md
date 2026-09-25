# Подразделы настроек не наследуют стили SettingsView (scoped CSS)

`.card`, `.row` и `.msg` объявлены в `SettingsView.vue` под `<style scoped>`, поэтому на
вынесенный дочерний компонент (`views/settings/*.vue`) они НЕ действуют; `.muted` приходит из
`web/src/styles/utilities.css`, а control skin — из канонических `Ui*` компонентов. Симптом
обманчивый: вёрстка выглядит «поехавшей» (текст
наложился на картинку, у карточек нет фона), и кажется, что дело в разметке, а не в отсутствии
правил. Новый подраздел задаёт у себя только domain layout/card styles и собирает controls из
`web/src/ui.ts`; копировать button/input skin из `SettingsView` нельзя.

Источник до переноса: docs/cockpit/gotchas.md § Подразделы настроек не наследуют стили SettingsView (scoped CSS)
