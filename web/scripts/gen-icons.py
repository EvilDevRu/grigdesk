#!/usr/bin/env python3
"""Создаёт производные иконки GrigDesk из утверждённых мастеров.

Без аргументов использует только docs/images/brand и не требует внешнего комплекта.
Для обновления мастеров: python3 -I web/scripts/gen-icons.py --kit /путь/к/комплекту.
Растры уменьшает Pillow LANCZOS, контуры SVG не растеризует и не меняет.
"""
import argparse
import base64
import re
import shutil
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import quote

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
BRAND = ROOT / 'docs/images/brand'
ANDROID = ROOT / 'mobile/android/app/src/main/res'
MASTERS = ('wordmark', 'wordmark-reversed', 'stacked', 'gd', 'gd-reversed',
           'gd-small', 'g-small', 'g-small-reversed', 'favicon-tile')
OLD_MASTERS = ('favicon', 'icon', 'mark', 'mark-light', 'mark-mono', 'mark-small')


def write(file: Path, text: str) -> None:
    """Записывает воспроизводимый UTF-8 и создаёт только каталоги результатов.
    Все пути задаёт генератор относительно корня репозитория.
    """
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(text, encoding='utf-8')


def import_masters(kit: Path) -> None:
    """Копирует только утверждённую карту файлов, не весь внешний комплект.
    Запрещённые экспорты и локальные заметки в продукт не попадают.
    """
    sources = {f'grigdesk-{name}.svg': kit / f'grigdesk-{name}.svg' for name in MASTERS}
    sources.update({
        'grigdesk-app-icon.svg': kit / 'export/app/grigdesk-gd-reversed-app-icon.svg',
        'grigdesk-app-icon-1024.png': kit / 'export/app/grigdesk-gd-reversed-app-icon-1024.png',
        'grigdesk-maskable-512.png': kit / 'export/web/maskable-512.png',
    })
    missing = [str(source) for source in sources.values() if not source.is_file()]

    if missing:
        raise RuntimeError('В комплекте нет файлов: ' + ', '.join(missing))

    BRAND.mkdir(parents=True, exist_ok=True)
    for name, source in sources.items():
        shutil.copyfile(source, BRAND / name)


def paths(name: str) -> list[str]:
    """Берёт только готовые контуры мастера без пересчёта координат.
    Те же байты пути используются компонентами и вектором Android.
    """
    document = ET.parse(BRAND / f'grigdesk-{name}.svg')

    return [node.attrib['d'] for node in document.findall('.//{http://www.w3.org/2000/svg}path')]


def component(mark: str, class_name: str) -> str:
    """Оборачивает неизменный контур G в компонент с цветом текста.
    Короткие строковые фрагменты сохраняют читаемость без изменения геометрии.
    """
    chunks = [mark[index:index + 85] for index in range(0, len(mark), 85)]
    literal = "const MARK = '" + chunks[0] + "'"
    literal += ''.join("\n  + '" + chunk + "'" for chunk in chunks[1:]) + ';'

    return f'''<template>
  <svg class="{class_name}" viewBox="0 0 256 256" aria-hidden="true" focusable="false">
    <path :d="MARK" />
  </svg>
</template>

<script setup lang="ts">
// Малая G для тёмного фона из grigdesk-g-small-reversed.svg.
// Генератор переносит контур без изменений; размер и цвет задаёт место использования.
{literal}
</script>

<style scoped>
:where(.{class_name}) {{
  width: 1em;
  height: 1em;
  flex: none;
}}

path {{
  fill: currentColor;
}}
</style>
'''


def android_foreground() -> str:
    """Помещает GD в безопасную область adaptive-иконки на холсте 108 dp.
    Координаты масштаба, сдвига и цвет зафиксированы утверждённой картой.
    """
    contours = '\n'.join(f'        <path android:fillColor="#F2F3F5" android:pathData="{value}" />'
                         for value in paths('gd-reversed'))

    return f'''<?xml version="1.0" encoding="utf-8"?>
<!-- Сгенерировано web/scripts/gen-icons.py из утверждённого мастера GD. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <group
        android:scaleX="0.21459"
        android:scaleY="0.21459"
        android:translateX="26.533"
        android:translateY="26.533">
{contours}
    </group>
</vector>
'''


def generate() -> None:
    """Создаёт все размеры из одного PNG, копирует встроенные URI и векторные контуры.
    Повторный запуск не меняет байты результата при неизменных мастерах и Pillow.
    """
    for name in OLD_MASTERS:
        (BRAND / f'grigdesk-{name}.svg').unlink(missing_ok=True)

    for source, target, colour in [('wordmark-reversed', 'wordmark-light', '#F2F3F5'),
                                   ('wordmark', 'wordmark-graphite', '#0B0D11')]:
        svg = (BRAND / f'grigdesk-{source}.svg').read_text(encoding='utf-8')
        write(BRAND / f'grigdesk-{target}.svg', svg.replace('fill="#000"', f'fill="{colour}"'))

    with Image.open(BRAND / 'grigdesk-app-icon-1024.png') as source:
        master = source.convert('RGBA')

    outputs = {ROOT / 'desktop/build/icon.png': 512, ROOT / 'desktop/build/window-icon.png': 64,
               ROOT / 'web/public/icon-96.png': 96}
    for area in ('web', 'mobile'):
        for size in (192, 512):
            outputs[ROOT / area / 'public' / f'icon-{size}.png'] = size

    for density, size in {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}.items():
        for suffix in ('', '_round'):
            outputs[ANDROID / f'mipmap-{density}' / f'ic_launcher{suffix}.png'] = size

    for file, size in outputs.items():
        file.parent.mkdir(parents=True, exist_ok=True)
        master.resize((size, size), Image.LANCZOS).save(file, format='PNG')

    shutil.copyfile(ROOT / 'web/public/icon-512.png', ROOT / 'bin/grigdesk.png')
    for area in ('web', 'mobile'):
        shutil.copyfile(BRAND / 'grigdesk-maskable-512.png', ROOT / area / 'public/icon-maskable-512.png')

    encoded = base64.b64encode((ROOT / 'web/public/icon-96.png').read_bytes()).decode('ascii')
    chunks = [encoded[index:index + 96] for index in range(0, len(encoded), 96)]
    literal = "export const NOTIFICATION_ICON = 'data:image/png;base64,'\n"
    literal += '\n'.join("  + '" + chunk + "'" for chunk in chunks) + ';\n'
    write(ROOT / 'web/src/shared/notificationIcon.ts',
          '// Иконка из web/public/icon-96.png входит в код как data URL.\n'
          '// Системному уведомлению не нужна cookie для загрузки защищённой статики.\n'
          + literal)

    favicon = (BRAND / 'grigdesk-favicon-tile.svg').read_text(encoding='utf-8')
    uri = 'data:image/svg+xml,' + quote(favicon, safe='')
    index = ROOT / 'web/index.html'
    html = index.read_text(encoding='utf-8')
    html, count = re.subn(r'(<link rel="icon" href=")[^"]*("\s*/>)',
                          lambda match: match[1] + uri + match[2], html)
    if count != 1:
        raise RuntimeError('В web/index.html должна быть одна встроенная иконка.')
    write(index, html)

    mark_paths = paths('g-small-reversed')
    if len(mark_paths) != 1:
        raise RuntimeError('Мастер малой G должен содержать один контур.')
    write(ROOT / 'web/src/shared/GrigDeskMark.vue', component(mark_paths[0], 'grigdesk-mark'))
    write(ROOT / 'mobile/src/ui/UiBrandMark.vue', component(mark_paths[0], 'ui-brand-mark'))
    write(ANDROID / 'drawable/ic_launcher_foreground.xml', android_foreground())
    write(ANDROID / 'values/ic_launcher_background.xml',
          '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
          '    <color name="ic_launcher_background">#0B0D11</color>\n</resources>\n')
    print('Иконки GrigDesk обновлены; favicon для встроенного использования:')
    print(uri)


def main() -> None:
    """Импорт внешнего комплекта выполняется лишь по явному аргументу.
    Обычная проверка воспроизводимости использует мастера самого репозитория.
    """
    parser = argparse.ArgumentParser(description='Производные знака GrigDesk')
    parser.add_argument('--kit', type=Path, help='Каталог утверждённого комплекта мастеров')
    args = parser.parse_args()

    if args.kit:
        import_masters(args.kit)
    generate()


if __name__ == '__main__':
    main()
