// Слова про сцену, общие для списка сцен и редактора: что запись делает на экране
// и в каком состоянии её клип. Два места обязаны говорить одинаково, поэтому
// формулировка одна.
import type { ShowcaseAction, ShowcaseScene } from '../../../../shared/plugins/showcase/showcaseContracts';

// Ожидания и паузы в строку не попадают: зрителю важно, куда нажали и что
// подсветили, а не сколько миллисекунд между этим прошло.
const ACTION_WORDS: Record<ShowcaseAction['kind'], string> = {
  goto: 'переход',
  click: 'клик',
  hover: 'курсор',
  highlight: 'подсветка',
  waitVisible: '',
  scroll: 'прокрутка',
  wait: '',
};

export interface SceneStateText {
  tone: 'good' | 'warn';
  label: string;
}

// Подпись сцены-продолжения: одна и та же в списке и в редакторе, чтобы человек
// узнавал её с первого взгляда.
export const CONTINUATION_LABEL = '↳ продолжает предыдущую';

// Экран, найденный браузером на пробном проходе: его нет в карте профиля, а
// идентификатор несёт адрес — человеку он говорит больше, чем название.
const PAGE_SCREEN_PREFIX = 'page:';

/**
 * Подпись экрана сцены: название из карты, а для экрана, найденного браузером,
 * — его адрес. Список сцен и редактор обязаны звать экран одинаково.
 */
export function screenLabelOf(
  screens: readonly { id: string; title: string }[],
  scene: Pick<ShowcaseScene, 'screenId'>,
): string {
  const declared = screens.find((screen) => screen.id === scene.screenId)?.title;

  if (declared) {
    return declared;
  }

  return scene.screenId.startsWith(PAGE_SCREEN_PREFIX)
    ? `страница ${scene.screenId.slice(PAGE_SCREEN_PREFIX.length)}`
    : scene.screenId;
}

/**
 * Действия сцены словами, в порядке исполнения. Пустая строка означает, что
 * запись покажет неподвижный экран — об этом вызывающая сторона говорит сама.
 */
export function actionsText(scene: ShowcaseScene): string {
  return scene.actions
    .map((action) => {
      const word = ACTION_WORDS[action.kind];

      if (!word) {
        return '';
      }

      return 'targetId' in action && action.targetId ? `${word}: ${action.targetId}` : word;
    })
    .filter(Boolean)
    .join(' → ');
}

/**
 * Состояние сцены одним словом. Устаревшая запись и отсутствующая — разные вещи:
 * первую сборка переснимет, вторую снимет впервые, и человеку важно, что именно.
 */
export function sceneStateOf(scene: ShowcaseScene): SceneStateText {
  if (scene.stale) {
    return scene.clip
      ? { tone: 'warn', label: 'нужна пересъёмка' }
      : { tone: 'warn', label: 'ещё не записана' };
  }

  if (!scene.audio) {
    return { tone: 'warn', label: 'без звука' };
  }

  return { tone: 'good', label: 'готова' };
}

/**
 * Таймкод «м:сс» из миллисекунд. Часы не показываются: ролик ограничен минутами,
 * и «0:01:25» читался бы как ошибка формата.
 */
export function timecode(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');

  return `${minutes}:${seconds}`;
}
