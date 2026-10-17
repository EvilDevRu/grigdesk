#!/usr/bin/env python3
"""
Генерация знака Кокпита «Шкала C» и всех его копий из одной геометрии.

Знак — дуга буквы C (публичное имя AI Cockpit) и стрелка прибора со ступицей: по-русски он
читается как шкала, поэтому не зависит от языка названия. Мастер — для 48 px и крупнее,
облегчённый срез (толще дуга и стрелка) — для 32 px и мельче.

Растр рисуем напрямую через Pillow с суперсэмплингом: растеризатора SVG в системе может не
быть, а фигуры простые. Векторные копии (SVG-исходники и adaptive-иконка Android) пишем из тех
же параметров, поэтому все размеры совпадают геометрически.

Запуск из корня репозитория: python3 web/scripts/gen-icons.py
"""
import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
WEB_PUBLIC = ROOT / 'web' / 'public'
MOBILE_PUBLIC = ROOT / 'mobile' / 'public'
ANDROID_RES = ROOT / 'mobile' / 'android' / 'app' / 'src' / 'main' / 'res'
BRAND_DIR = ROOT / 'docs' / 'images' / 'brand'
DESKTOP_BUILD = ROOT / 'desktop' / 'build'

BG = '#0b0d11'             # фон плитки: theme-color веба
INK = '#e7eaf0'            # дуга на тёмном: основной текст интерфейса
ACCENT = '#5aa2ff'         # стрелка: синий акцент
INK_ON_LIGHT = '#0b0d11'   # дуга на светлом
ACCENT_ON_LIGHT = '#3d8bf0'  # стрелка на светлом: #5aa2ff даёт меньше 3:1 к белому

# Геометрия на холсте 256×256. Центр C сдвинут вправо: тяжёлая спинка буквы иначе перевешивает.
# Края стрелки идут под ровными углами (−30° и −10° у мастера, −30° и 0° у среза).
MASTER = dict(cx=140, cy=128, ro=104, ri=74, gap=50, hub=24,
              base=92 * math.tan(math.radians(10)), tip=92, angle=-20)
SMALL = dict(cx=140, cy=128, ro=106, ri=64, gap=54, hub=31,
             base=90 * math.tan(math.radians(15)), tip=90, angle=-15)

SS = 4            # суперсэмплинг растра
TILE_SCALE = 0.68  # доля плитки под знак
MASK_SCALE = 0.64  # maskable: самая дальняя точка знака остаётся внутри safe zone (80%)


def num(value: float) -> str:
    return f'{value:.2f}'.rstrip('0').rstrip('.')


def polar(g: dict, radius: float, degrees: float) -> tuple[float, float]:
    rad = math.radians(degrees)
    return g['cx'] + radius * math.cos(rad), g['cy'] + radius * math.sin(rad)


def needle_points(g: dict) -> list[tuple[float, float]]:
    """
    Стрелка — треугольник от ступицы к острию: основание поперёк оси стрелки.
    Порядок вершин совпадает по обходу с дугой и ступицей, чтобы их объединение не дало дыр.
    """
    rad = math.radians(g['angle'])
    ux, uy = math.cos(rad), math.sin(rad)
    nx, ny = -uy * g['base'], ux * g['base']
    tip = (g['cx'] + ux * g['tip'], g['cy'] + uy * g['tip'])

    return [(g['cx'] + nx, g['cy'] + ny), tip, (g['cx'] - nx, g['cy'] - ny)]


def arc_points(g: dict, steps: int = 720) -> list[tuple[float, float]]:
    """
    Многоугольник дуги C для растра: внешняя окружность от верхнего конца через спинку
    к нижнему, затем внутренняя обратно. Концы срезаны по радиусу под ±gap.
    """
    span = 360 - 2 * g['gap']
    angles = [-g['gap'] - span * i / steps for i in range(steps + 1)]
    outer = [polar(g, g['ro'], a) for a in angles]
    inner = [polar(g, g['ri'], a) for a in reversed(angles)]

    return outer + inner


def path_data(g: dict) -> tuple[str, str]:
    """
    Пути SVG для дуги и для стрелки со ступицей — отдельно, чтобы красить в разные цвета.
    Используются и в SVG-исходниках, и в векторе Android (pathData понимает дуги A).
    """
    gap, ro, ri, hub = g['gap'], g['ro'], g['ri'], g['hub']
    o1, o2 = polar(g, ro, -gap), polar(g, ro, gap)
    i1, i2 = polar(g, ri, -gap), polar(g, ri, gap)
    arc = (f'M{num(o1[0])} {num(o1[1])}A{num(ro)} {num(ro)} 0 1 0 {num(o2[0])} {num(o2[1])}'
           f'L{num(i2[0])} {num(i2[1])}A{num(ri)} {num(ri)} 0 1 1 {num(i1[0])} {num(i1[1])}Z')

    cx, cy = g['cx'], g['cy']
    hub_d = (f'M{num(cx - hub)} {num(cy)}A{num(hub)} {num(hub)} 0 1 0 {num(cx + hub)} {num(cy)}'
             f'A{num(hub)} {num(hub)} 0 1 0 {num(cx - hub)} {num(cy)}Z')
    a, tip, b = needle_points(g)
    needle = f'M{num(a[0])} {num(a[1])}L{num(tip[0])} {num(tip[1])}L{num(b[0])} {num(b[1])}Z'

    return arc, hub_d + needle


def draw_mark(img: Image.Image, g: dict, box: float, off: float, arc_color: str, needle_color: str) -> None:
    """
    Рисует знак в квадрат box×box со смещением off (в пикселях холста img).
    Координаты геометрии — на холсте 256, поэтому всё масштабируется одним множителем.
    """
    k = box / 256
    d = ImageDraw.Draw(img)

    def place(points):
        return [(off + x * k, off + y * k) for x, y in points]

    d.polygon(place(arc_points(g)), fill=arc_color)
    d.polygon(place(needle_points(g)), fill=needle_color)
    hx, hy, hr = off + g['cx'] * k, off + g['cy'] * k, g['hub'] * k
    d.ellipse([hx - hr, hy - hr, hx + hr, hy + hr], fill=needle_color)


def draw_icon(size: int, *, shape: str, g: dict = MASTER) -> Image.Image:
    """
    Иконка приложения: tile — скруглённая плитка (радиус 22%), round — круг (Android до 8.0),
    maskable — фон на всё полотно, знак вписан в safe zone: форму вырежет сам Android.
    """
    s = size * SS
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if shape == 'maskable':
        d.rectangle([0, 0, s, s], fill=BG)
        scale = MASK_SCALE
    elif shape == 'round':
        d.ellipse([0, 0, s - 1, s - 1], fill=BG)
        scale = 0.62
    else:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=round(s * 0.22), fill=BG)
        scale = TILE_SCALE

    box = s * scale
    draw_mark(img, g, box, (s - box) / 2, INK, ACCENT)

    return img.resize((size, size), Image.LANCZOS)


def svg_mark(g: dict, arc_color: str, needle_color: str, title: str) -> str:
    arc, needle = path_data(g)

    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" '
            f'role="img"><title>{title}</title><path fill="{arc_color}" d="{arc}"/>'
            f'<path fill="{needle_color}" d="{needle}"/></svg>\n')


def svg_icon(g: dict) -> str:
    """
    Плитка приложения в векторе: тот же радиус и та же доля знака, что у PNG-иконок.
    Знак вложен через transform одной обёртки — пути остаются общими с исходником знака.
    """
    arc, needle = path_data(g)
    k = TILE_SCALE
    off = num(256 * (1 - k) / 2)

    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" '
            f'role="img"><title>AI Cockpit</title><rect width="256" height="256" rx="{num(256 * 0.22)}" '
            f'fill="{BG}"/><g transform="translate({off} {off}) scale({num(k)})">'
            f'<path fill="{INK}" d="{arc}"/><path fill="{ACCENT}" d="{needle}"/></g></svg>\n')


def svg_favicon(g: dict) -> str:
    """
    Favicon: облегчённый срез на плитке, знак крупнее (80%) — во вкладке он виден в 16 px.
    Кавычки одинарные: строка без правок встраивается в index.html как data:-URI.
    """
    arc, needle = path_data(g)
    k = 0.8
    off = num(256 * (1 - k) / 2)

    return (f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256'>"
            f"<rect width='256' height='256' rx='56' fill='{BG}'/>"
            f"<g transform='translate({off} {off}) scale({num(k)})'><path fill='{INK}' d='{arc}'/>"
            f"<path fill='{ACCENT}' d='{needle}'/></g></svg>")


def data_uri(svg: str) -> str:
    return 'data:image/svg+xml,' + svg.replace('<', '%3C').replace('>', '%3E').replace('#', '%23')


def android_foreground(g: dict) -> str:
    """
    Передний слой adaptive-иконки Android (холст 108 dp, safe zone — круг 66 dp).
    Знак занимает 50 dp: на видимых 72 dp это та же доля, что у плитки PWA.
    """
    arc, needle = path_data(g)
    box = 50
    k = box / 256
    off = (108 - box) / 2

    return f'''<?xml version="1.0" encoding="utf-8"?>
<!-- Сгенерировано web/scripts/gen-icons.py: знак «Шкала C», не править вручную. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <group
        android:scaleX="{k:.5f}"
        android:scaleY="{k:.5f}"
        android:translateX="{num(off)}"
        android:translateY="{num(off)}">
        <path
            android:fillColor="{INK.upper()}"
            android:pathData="{arc}" />
        <path
            android:fillColor="{ACCENT.upper()}"
            android:pathData="{needle}" />
    </group>
</vector>
'''


def save(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path)
    print(path.relative_to(ROOT))


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')
    print(path.relative_to(ROOT))


def write_desktop_icons() -> None:
    """
    Большая плитка нужна упаковщику и меню, отдельная 64 px — системным окнам.
    Панель задач плохо уменьшает 512 px: заранее сглаженный растр сохраняет края знака.
    """
    save(draw_icon(512, shape='tile'), DESKTOP_BUILD / 'icon.png')
    save(draw_icon(64, shape='tile'), DESKTOP_BUILD / 'window-icon.png')


def main() -> None:
    """
    Пишет все копии знака: PNG для веба, телефона и окна, mipmap Android для старых лончеров,
    вектор adaptive-иконки и SVG-исходники в docs/images/brand.
    """
    write_desktop_icons()

    for public in (WEB_PUBLIC, MOBILE_PUBLIC):
        for size in (192, 512):
            save(draw_icon(size, shape='tile'), public / f'icon-{size}.png')
        save(draw_icon(512, shape='maskable'), public / 'icon-maskable-512.png')

    # Иконка системных оповещений (notify.ts) видна мелко — берём облегчённый срез.
    save(draw_icon(96, shape='tile', g=SMALL), WEB_PUBLIC / 'icon-96.png')

    densities = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
    for name, size in densities.items():
        g = SMALL if size < 96 else MASTER
        save(draw_icon(size, shape='tile', g=g), ANDROID_RES / f'mipmap-{name}' / 'ic_launcher.png')
        save(draw_icon(size, shape='round', g=g), ANDROID_RES / f'mipmap-{name}' / 'ic_launcher_round.png')
    write_text(ANDROID_RES / 'drawable' / 'ic_launcher_foreground.xml', android_foreground(MASTER))

    write_text(BRAND_DIR / 'cockpit-mark.svg', svg_mark(MASTER, INK, ACCENT, 'AI Cockpit'))
    write_text(BRAND_DIR / 'cockpit-mark-light.svg',
               svg_mark(MASTER, INK_ON_LIGHT, ACCENT_ON_LIGHT, 'AI Cockpit'))
    write_text(BRAND_DIR / 'cockpit-mark-mono.svg',
               svg_mark(MASTER, 'currentColor', 'currentColor', 'AI Cockpit'))
    write_text(BRAND_DIR / 'cockpit-mark-small.svg', svg_mark(SMALL, INK, ACCENT, 'AI Cockpit'))
    write_text(BRAND_DIR / 'cockpit-icon.svg', svg_icon(MASTER))
    write_text(BRAND_DIR / 'cockpit-favicon.svg', svg_favicon(SMALL) + '\n')

    # Копии, которые живут в исходниках: компоненты знака и favicon в web/index.html.
    arc, needle = path_data(SMALL)
    print(f'\nПути облегчённого среза (CockpitMark.vue, UiBrandMark.vue):\narc:    {arc}\nneedle: {needle}')
    print(f'\nfavicon для web/index.html:\n{data_uri(svg_favicon(SMALL))}')


if __name__ == '__main__':
    main()
