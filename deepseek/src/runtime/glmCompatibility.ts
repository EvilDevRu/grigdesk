import compatibility from '../../compatibility/glm.json' with { type: 'json' };

// Допуск выпуска принадлежит пакету и остаётся неизменяемым после загрузки.
// Сервер получает эту запись из metadata выбранного ELF, без импорта данного файла.
const admission: ReadonlyArray<{ mode: string; compatibility: string }> = compatibility.admission;

export const GLM_ADMISSION = Object.freeze(admission.map((entry) => Object.freeze({
  mode: entry.mode,
  compatibility: entry.compatibility,
})));

export const GLM_COMPATIBILITY = Object.freeze({
  ...compatibility,
  admission: GLM_ADMISSION,
});
