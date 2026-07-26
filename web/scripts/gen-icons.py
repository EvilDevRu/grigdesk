#!/usr/bin/env python3
"""
Генерация иконок PWA из геометрии favicon'а (тёмный скруглённый квадрат + синяя рамка).

Рисуем напрямую через Pillow: растеризатора SVG в системе нет (ни ImageMagick, ни rsvg,
ни cairosvg), а фигура простая — тащить зависимость ради неё смысла нет.

Иконки нужны для установки PWA: Chrome не предложит установку без 192 и 512 px в манифесте.
Отдельно кладём maskable-вариант — Android режет иконку под адаптивную форму (круг/сквиркл),
поэтому там рисунок вписан в safe zone (центральные ~80%), иначе рамку обрежет по краям.

Запуск: python3 scripts/gen-icons.py
"""
from PIL import Image, ImageDraw

BG = (11, 13, 17, 255)       # #0b0d11 — фон палитры кокпита
ACCENT = (90, 162, 255, 255)  # #5aa2ff — синий акцент
OUT = 'public'
SS = 4  # суперсэмплинг: рисуем крупнее и уменьшаем — даёт гладкие края без сглаживания фигур


def draw_icon(size: int, *, maskable: bool) -> Image.Image:
    s = size * SS
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if maskable:
        # Подложка на всё полотно: обрежется по форме маски самим Android.
        d.rectangle([0, 0, s, s], fill=BG)
        # Рисунок — в safe zone (80% от полотна).
        inner = s * 0.8
        off = (s - inner) / 2
    else:
        # Обычная иконка: свой скруглённый квадрат, как у favicon (радиус 7/32).
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 7 / 32), fill=BG)
        inner = s
        off = 0

    # Рамка-квадрат: пропорции с favicon (x=7,y=7,w=18,h=18,r=3,stroke=2.6 при 32px).
    x0 = off + inner * 7 / 32
    y0 = off + inner * 7 / 32
    x1 = off + inner * 25 / 32
    y1 = off + inner * 25 / 32
    d.rounded_rectangle(
        [x0, y0, x1, y1],
        radius=inner * 3 / 32,
        outline=ACCENT,
        width=max(1, round(inner * 2.6 / 32)),
    )

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    for size in (192, 512):
        draw_icon(size, maskable=False).save(f'{OUT}/icon-{size}.png')
        print(f'{OUT}/icon-{size}.png')
    draw_icon(512, maskable=True).save(f'{OUT}/icon-maskable-512.png')
    print(f'{OUT}/icon-maskable-512.png')
    # Иконка для системных оповещений (notify.js) — мелкая, отдельным файлом.
    draw_icon(96, maskable=False).save(f'{OUT}/icon-96.png')
    print(f'{OUT}/icon-96.png')


if __name__ == '__main__':
    main()
