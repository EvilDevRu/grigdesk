// Форматирование величин панели докера.
//
// Общий fmtBytes проекта останавливается на мегабайтах — для доски задач этого хватает,
// а здесь речь про образы на 163 ГБ, и «167000.0 МБ» человек не прочитает. Поэтому у
// докера своя шкала, до терабайт, и она живёт рядом со своими экранами.

import type {
  DockerContainer,
  DockerImage,
  DockerPort,
} from '../../../../shared/plugins/docker/dockerContracts';

const UNITS = [
  { limit: 1024 ** 4, suffix: 'ТБ' },
  { limit: 1024 ** 3, suffix: 'ГБ' },
  { limit: 1024 ** 2, suffix: 'МБ' },
  { limit: 1024, suffix: 'КБ' },
];

/**
 * Размеры Docker показываются в одной шкале для образов, памяти и очистки.
 * Отсутствующий или недопустимый размер сохраняет прежнее представление «0 Б».
 */
export function formatSize(value: number | null | undefined): string {
  const bytes = Number(value);

  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 Б';
  }

  for (const unit of UNITS) {
    if (bytes >= unit.limit) {
      const scaled = bytes / unit.limit;

      return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)} ${unit.suffix}`;
    }
  }

  return `${Math.round(bytes)} Б`;
}

/**
 * Возраст объекта выражается относительным временем: точная дата доступна демону,
 * а пустая или повреждённая дата не должна превращаться в NaN на экране.
 */
export function formatAge(iso: string | null | undefined): string {
  if (!iso) {
    return '';
  }

  const at = new Date(iso).getTime();

  if (!Number.isFinite(at)) {
    return '';
  }

  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));

  if (minutes < 60) {
    return `${minutes} мин`;
  }

  const hours = Math.round(minutes / 60);

  if (hours < 48) {
    return `${hours} ч`;
  }

  const days = Math.round(hours / 24);

  if (days < 60) {
    return `${days} дн`;
  }

  const months = Math.round(days / 30);

  return months < 24 ? `${months} мес` : `${Math.round(months / 12)} г`;
}

/**
 * Опубликованный порт показывается как связь наружу → внутрь.
 * Внутренний порт сохраняет протокол, поскольку внешнего адреса у него нет.
 */
export function formatPort(port: DockerPort): string {
  if (!port.published) {
    return `${port.target}/${port.protocol}`;
  }

  return `${port.published} → ${port.target}${port.protocol === 'tcp' ? '' : `/${port.protocol}`}`;
}

const STATE_LABELS: Record<string, string> = {
  running: 'работает',
  exited: 'остановлен',
  created: 'создан',
  restarting: 'перезапускается',
  paused: 'на паузе',
  dead: 'мёртв',
  removing: 'удаляется',
};

/**
 * Известные состояния получают русские подписи. Новое состояние демона
 * сохраняется буквально, чтобы панель не скрывала полезную диагностику.
 */
export function stateLabel(state: DockerContainer['state']): string {
  return STATE_LABELS[state] || state || '—';
}

/**
 * Тон карточки сначала отражает проверку здоровья, затем состояние контейнера.
 * Так неисправный, но запущенный контейнер не получает зелёную отметку.
 */
export function stateTone(container: DockerContainer): 'bad' | 'warn' | 'good' | 'idle' {
  if (container.health === 'unhealthy') {
    return 'bad';
  }
  if (container.state === 'running') {
    return container.health === 'starting' ? 'warn' : 'good';
  }
  if (['restarting', 'removing'].includes(container.state)) {
    return 'warn';
  }
  if (container.state === 'dead') {
    return 'bad';
  }

  return 'idle';
}

/**
 * Образ показывается по тегам, а после их удаления — по короткому ID.
 * Так безымянные образы остаются различимыми в списке и подтверждении.
 */
export function formatTags(image: DockerImage): string {
  if (image.tags.length) {
    return image.tags.join(', ');
  }

  return `<без тега> ${image.shortId}`;
}
