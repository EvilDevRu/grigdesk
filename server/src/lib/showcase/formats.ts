// Формат ролика, расширения артефактов и версии производителей.
//
// Всё это входит в хеши артефактов: другая версия инструмента из тех же действий
// даёт другую картинку, и считать прежний клип свежим было бы неправдой. Поэтому
// значения лежат в одном месте — разъехавшиеся копии означали бы, что часть
// ролика пересчитана по одним правилам, а часть по другим.
import type { RenderStyle } from './artifacts.ts';
import type { ShowcaseArtifactRef } from '../../../../shared/showcaseContracts.ts';

// Формат ИТОГА, а не обещание о частоте исходной записи браузера: она своя и
// приводится к этой при сборке сцены.
export const RENDER_STYLE: RenderStyle = {
  width: 1920,
  height: 1080,
  fps: 30,
  theme: 'dark',
  locale: 'ru-RU',
  burnSubtitles: false,
};

// Расширение определяется видом артефакта, а не именем, пришедшим извне: имя из
// запроса в путь не попадает вовсе.
const ARTIFACT_EXTENSIONS: Record<ShowcaseArtifactRef['kind'], string> = {
  audio: '.wav',
  clip: '.webm',
  frame: '.png',
  final: '.mp4',
  subtitles: '.srt',
};

export const PRODUCER_VERSIONS = {
  recorder: 'recorder-1',
  voice: 'imported-1',
  assembler: 'assembler-1',
};

export function extensionOf(kind: ShowcaseArtifactRef['kind']): string {
  return ARTIFACT_EXTENSIONS[kind];
}
