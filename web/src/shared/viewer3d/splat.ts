export interface SplatData {
  count: number;
  positions: Float32Array;
  scales: Float32Array;
  colors: Uint8Array;
  rotations: Float32Array;
}

/**
 * Ограниченный предпросмотр читает полные 32-байтовые записи и не выдумывает неполный хвост.
 * Все координаты/масштабы конечны; два миллиона точек ограничивают память браузера.
 */
export function parseSplat(bytes: Uint8Array | ArrayBuffer): SplatData {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const count = Math.floor(data.byteLength / 32);
  
  if (count > 2_000_000) {
    throw new Error('Слишком много точек для предпросмотра splat (предел 2 млн).');
  }
  
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const positions = new Float32Array(count * 3);
  const scales = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const rotations = new Float32Array(count * 4);
  
  for (let index = 0; index < count; index += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const position = view.getFloat32(index * 32 + axis * 4, true);
      const scale = view.getFloat32(index * 32 + 12 + axis * 4, true);
      
      if (!Number.isFinite(position) || !Number.isFinite(scale)) {
        throw new Error('Некорректная координата или масштаб splat.');
      }
      
      positions[index * 3 + axis] = position;
      scales[index * 3 + axis] = scale;
    }
    
    colors.set(data.subarray(index * 32 + 24, index * 32 + 28), index * 4);
    
    for (let axis = 0; axis < 4; axis += 1) {
      rotations[index * 4 + axis] =
      (data[index * 32 + 28 + axis]! - 128) / 128;
    }
  }
  
  return {
    count,
    positions,
    scales,
    colors,
    rotations
  };
}
