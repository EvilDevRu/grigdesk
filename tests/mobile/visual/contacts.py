import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def main():
    """Лист собирает проверенные кадры одного сценария, сохраняя пропорции каждого окна.
    Источник — собственный JSON отчёт; PNG пишутся рядом с кадрами вне git.
    """
    root = Path(sys.argv[1])
    report = json.loads((root / 'report.json').read_text())

    try:
        font = ImageFont.truetype('DejaVuSans.ttf', 16)
    except OSError:
        font = ImageFont.load_default()

    for scenario in sorted({row['name'] for row in report}):
        rows = [row for row in report if row['name'] == scenario]
        # Высота по числу кадров: 14 размеров x 2 шрифта не помещались в прежние 4 ряда.
        sheet = Image.new('RGB', (1620, max(1, -(-len(rows) // 6)) * 350), '#20242a')
        draw = ImageDraw.Draw(sheet)

        for index, row in enumerate(rows):
            directory = root / (row['size'] + '-' + str(row['fontScale']))
            photo = Image.open(directory / (scenario + '.png')).convert('RGB')
            photo.thumbnail((250, 312), Image.LANCZOS)
            left = (index % 6) * 270
            top = (index // 6) * 350
            label = row['size'] + ' x' + str(row['fontScale'])

            draw.text((left + 8, top + 6), label, font=font, fill='white')
            sheet.paste(photo, (left + (270 - photo.width) // 2, top + 30))

        sheet.save(root / ('contact-' + scenario + '.png'))


if __name__ == '__main__':
    main()
