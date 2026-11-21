/**
 * Полублоки сохраняют квадратные модули QR в обычном моноширинном терминале.
 * Поле вокруг кода также входит в строки, поэтому сканеру не нужна ручная рамка.
 */
export function renderTerminalQr(rows: readonly string[], color = false): string {
  if (!rows.length || rows.some((row) => row.length !== rows.length || !/^[01]+$/.test(row))) {
    throw new Error('Неверная матрица QR.');
  }

  const width = rows.length + 8;
  const lines: string[] = [];

  for (let y = 0; y < width; y += 2) {
    let line = '';

    for (let x = 0; x < width; x += 1) {
      const top = rows[y - 4]?.[x - 4] === '1';
      const bottom = rows[y - 3]?.[x - 4] === '1';

      line += [' ', '▀', '▄', '█'][(top ? 1 : 0) + (bottom ? 2 : 0)];
    }

    lines.push(color ? `\x1b[30;47m${line}\x1b[0m` : line);
  }

  return lines.join('\n') + '\n';
}
