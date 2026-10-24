# Размер кнопки

`UiButton` принимает параметр `size`: `default` (по умолчанию) или `compact`. Значение
выводится в атрибут `data-size`; неизвестное значение даёт `default`. Тип и нормализация —
`UiActionSize` и `normalizeActionSize` в `web/src/types/uiActions.ts`.

| Размер | Высота desktop | Высота touch | Поля по бокам | Шрифт |
| --- | ---: | ---: | ---: | --- |
| `default` | `--control-height`, 36 px (32 px в `data-ui-workspace`) | 44 px | 13 px | наследуется |
| `compact` | `--toolbar-control-h`, 28 px | 44 px | 7 px | 12 px |

Компактная кнопка берёт тот же токен, что панели инструментов, поэтому совпадает по высоте
с действиями `data-context="workspace-toolbar"`. Скругление и палитра остаются у места:
в переписке — обычные `--control-radius`, в рабочих формах — `--radius-sm`. На touch токен
поднимается до 44 px, и площадка нажатия не сжимается.

Размер выбирается параметром, а не заимствованием чужого `data-context`. Правило стилей —
`.ui-button[data-size='compact']` в `web/src/styles/components/actions.css`. Метки мест с
той же геометрией (`workspace-toolbar` и соседние) пока остаются; перевод их на `size` —
отдельная работа.

Первый потребитель — кнопка «▶ Продолжить ход» под оборванным ходом чата
(`data-role="chat-resume-interrupted"`). Проверки: `tests/web/ui-button.component.test.js`
и `tests/web/chat-resume-interrupted.component.test.js`.
