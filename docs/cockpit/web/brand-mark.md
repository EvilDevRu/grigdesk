# Знак Кокпита «Шкала C»

Знак — дуга буквы C и стрелка прибора со ступицей. Публичное имя проекта латиницей — AI Cockpit,
в интерфейсе и APK — «Кокпит»: по-английски знак читается как C, по-русски как шкала прибора,
поэтому буква К в знаке не используется.

## Источник

Геометрия задана один раз в `web/scripts/gen-icons.py` (запуск из корня:
`python3 web/scripts/gen-icons.py`). Скрипт рисует растр через Pillow и пишет векторные копии из тех
же параметров:

- Интерфейс приложения: `web/public/icon-{96,192,512}.png`, `icon-maskable-512.png`;
- Desktop: `desktop/build/icon.png` (512 px для пакета) и `window-icon.png`
  (64 px для системных окон; [причина отдельного размера](desktop-window-icon.md));
- PWA телефона: `mobile/public/icon-{192,512}.png`, `icon-maskable-512.png`;
- Android до 8.0: `mipmap-*/ic_launcher.png` и `ic_launcher_round.png`;
- adaptive-иконка и splash Android: `drawable/ic_launcher_foreground.xml` (знак 50 dp на холсте
  108 dp, внутри safe zone; фон — `values/ic_launcher_background.xml`);
- исходники: `docs/images/brand/` — знак для тёмного и светлого фона, одноцветный, облегчённый
  срез, плитка приложения и favicon.

Скрипт печатает пути облегчённого среза и `data:`-URI favicon. Их копии живут в исходниках:
`web/src/shared/CockpitMark.vue`, `mobile/src/ui/UiBrandMark.vue` и `<link rel="icon">` в
`web/index.html`. После правки геометрии эти три места обновляются вручную.

## Два среза

- Мастер — для 48 px и крупнее.
- Облегчённый срез — для 32 px и мельче: толще дуга и стрелка, крупнее ступица. Он стоит в
  шапке веба, в оболочке телефона, в favicon, в иконке оповещений (`icon-96.png`)
  и в mipmap mdpi/hdpi.

## Цвет

| Где | Дуга | Стрелка и ступица |
| --- | --- | --- |
| Тёмный фон (основной) | `#e7eaf0` (`--ink`) | `#5aa2ff` (`--accent`) |
| Светлый фон | `#0b0d11` | `#3d8bf0` — у `#5aa2ff` к белому меньше 3:1 |
| Один цвет | `currentColor` | `currentColor` |

Плитка приложения — `#0b0d11` (theme-color веба), радиус 22%, знак занимает 68% стороны; в
maskable-иконке — 64%, чтобы самая дальняя точка знака осталась в safe zone.

В интерфейсе `CockpitMark` красит дугу цветом текста родителя, стрелку — `--accent`; с `mono`
стрелка тоже берёт `currentColor`.
