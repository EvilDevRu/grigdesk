// Разрез листа ищет широкие полосы фона без обучения и сетевых запросов.
// Обход линейный, дополнительная память зависит от ширины, не от числа пикселей.
export interface StudioSheetImage {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

export interface StudioSheetRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Углы задают цвет фона; шум ниже threshold и колонки с плотностью <0,5% пусты.
 * Содержимое режется слева направо, обрезается по высоте и получает 2% поля.
 */
export function sheetSplit(image: StudioSheetImage,
  { threshold = 24, minGap = 0.01 }: { threshold?: number; minGap?: number } = {}): StudioSheetRect[] {
  const { width, height, data } = image;
  
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width > 65536 || height > 65536 || width * height > 64 * 1024 * 1024
    || data.length !== width * height * 4 || !Number.isFinite(threshold) || threshold < 0
    || !Number.isFinite(minGap) || minGap <= 0 || minGap > 1) {
    throw new Error('Неверный размер или параметры листа изображений.');
  }
  
  const corners = [0, (width - 1) * 4, (height - 1) * width * 4, (width * height - 1) * 4];
  const background = [0, 1, 2, 3].map((channel) =>
    corners.reduce((sum, index) => sum + (data[index + channel] ?? 0), 0) / 4);
  const counts = new Uint32Array(width);
  const top = new Int32Array(width).fill(height);
  const bottom = new Int32Array(width).fill(-1);
  
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const transparent = (data[index + 3] ?? 0) <= 5 && background[3]! <= 5;
      const difference = transparent ? 0 : background.reduce((sum, channel, offset) =>
        sum + Math.abs((data[index + offset] ?? 0) - channel), 0);
      
      if (difference > threshold) {
        counts[x] = counts[x]! + 1;
        top[x] = Math.min(top[x]!, y);
        bottom[x] = y;
      }
    }
  }
  
  const gap = Math.max(1, Math.ceil(width * minGap));
  const ranges: [number, number][] = [];
  let start = -1;
  let last = -1;
  
  for (let x = 0; x < width; x += 1) {
    if (counts[x]! / height >= 0.005) {
      if (start < 0) {
        start = x;
      }
      
      last = x;
    } else if (start >= 0 && x - last >= gap) {
      ranges.push([start, last]);
      start = -1;
    }
  }
  
  if (start >= 0) {
    ranges.push([start, last]);
  }
  
  return ranges.map(([left, right]) => {
    let firstRow = height;
    let lastRow = -1;
    
    for (let x = left; x <= right; x += 1) {
      firstRow = Math.min(firstRow, top[x]!);
      lastRow = Math.max(lastRow, bottom[x]!);
    }
    
    const padX = Math.max(1, Math.ceil((right - left + 1) * 0.02));
    const padY = Math.max(1, Math.ceil((lastRow - firstRow + 1) * 0.02));
    const x = Math.max(0, left - padX);
    const y = Math.max(0, firstRow - padY);
    
    return {
      x,
      y,
      width: Math.min(width, right + padX + 1) - x,
      height: Math.min(height, lastRow + padY + 1) - y
    };
  });
}
