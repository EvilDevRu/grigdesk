# Escape закрывает только верхний слой

Dock, tools-popover, модалки, confirm и закреплённые popover регистрируются через
`useUiLayer` из `web/src/ui.ts`. Consumer выбирает semantic имя (`dock`, `tools`, `popover`,
`dialog`, `confirm`), а private `services/layers/priorities.ts` назначает уровень. Один Escape
вызывает close ровно одного верхнего слоя. Не добавлять независимый `document.keydown` рядом:
он закроет несколько слоёв за одно событие. События из Monaco и xterm помечены
`data-escape-owner`; их локальный Escape не должен красться глобальным стеком.
