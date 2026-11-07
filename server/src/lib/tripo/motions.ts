// Готовые движения Tripo с русскими подписями и группами. Набор зависит от версии
// скелета: у человеческого v1.0 больше сотни движений, у скелета существ v2.5 —
// одиннадцать общих и по одному на тип тела. Идентификаторы сверены с документацией
// developers.tripo3d.ai 11.10.2026.

export interface Motion {
  id: string;
  label: string;
  group: string;
}

export const RIG_TYPES = [
  {
    value: 'biped',
    label: 'Двуногий'
  },
  {
    value: 'quadruped',
    label: 'Четвероногий'
  },
  {
    value: 'hexapod',
    label: 'Шестиногий'
  },
  {
    value: 'octopod',
    label: 'Восьминогий'
  },
  {
    value: 'avian',
    label: 'Птица'
  },
  {
    value: 'serpentine',
    label: 'Змея'
  },
  {
    value: 'aquatic',
    label: 'Водное'
  },
] as const;

const STANCE = 'Стойки и ожидание';
const MOVE = 'Перемещение';
const DAMAGE = 'Урон и страх';
const COMBAT = 'Бой';
const WORK = 'Работа и быт';
const EMOTION = 'Эмоции и жесты';
const SPORT = 'Спорт, танцы и пение';

// Пары «имя у Tripo — подпись» скелета человека; группа задаётся ниже списками.
const BIPED_LABELS: Readonly<Record<string, string>> = {
  idle: 'Покой',
  standing_relax: 'Стоять расслабленно',
  wait: 'Ждать',
  look_around: 'Оглядеться',
  fold_arms: 'Скрестить руки',
  scratch: 'Почесаться',
  depressed: 'Подавленность',
  walk: 'Ходьба',
  run: 'Бег',
  run_upstairs: 'Бег по лестнице',
  turn: 'Поворот',
  jump: 'Прыжок',
  jump_down: 'Спрыгнуть',
  fall: 'Падение',
  climb: 'Лезть вверх',
  dive: 'Нырок',
  flip: 'Сальто',
  swim: 'Плыть',
  swagger: 'Развязная походка',
  hurt: 'Ранение',
  hit_to_body_01: 'Удар в корпус 1',
  hit_to_body_02: 'Удар в корпус 2',
  hit_to_head: 'Удар в голову',
  hit_to_side: 'Удар в бок',
  hit_to_stomach: 'Удар в живот',
  flee_01: 'Бегство 1',
  flee_02: 'Бегство 2',
  afraid: 'Бояться',
  frightened: 'Испуг',
  scared_01: 'Страх 1',
  scared_02: 'Страх 2',
  defeat_02: 'Поражение 1',
  defeat_03: 'Поражение 2',
  shoot: 'Выстрел',
  fire: 'Стрельба',
  slash: 'Рубящий удар',
  chop: 'Рубить',
  box_01: 'Бокс 1',
  box_02: 'Бокс 2',
  box_03: 'Бокс 3',
  front_kick_01: 'Удар ногой 1',
  front_kick_02: 'Удар ногой 2',
  cast_a_spell: 'Заклинание',
  lift_heavy: 'Поднять тяжёлое',
  shovel: 'Лопата',
  dig: 'Копать',
  sit: 'Сесть',
  make_a_call_01: 'Звонок 1',
  make_a_call_02: 'Звонок 2',
  play_mobile_game: 'Игра на телефоне',
  play_video_game: 'Видеоигра',
  agree: 'Согласиться',
  angry_01: 'Злость 1',
  angry_02: 'Злость 2',
  angry_03: 'Злость 3',
  complain_01: 'Жаловаться 1',
  complain_02: 'Жаловаться 2',
  frustrated_01: 'Досада 1',
  frustrated_02: 'Досада 2',
  cry: 'Плакать',
  sob: 'Рыдать',
  laugh_01: 'Смех 1',
  laugh_02: 'Смех 2',
  cheer: 'Ликовать',
  clap: 'Хлопать',
  greet_01: 'Приветствие 1',
  greet_02: 'Приветствие 2',
  greet_03: 'Приветствие 3',
  greet_04: 'Приветствие 4',
  wave_goodbye_01: 'Помахать на прощание 1',
  wave_goodbye_02: 'Помахать на прощание 2',
  bow: 'Поклон',
  hug: 'Обнять',
  heart_pose: 'Сердечко руками',
  victory_celebration: 'Победа',
  dance_01: 'Танец 1',
  dance_02: 'Танец 2',
  dance_03: 'Танец 3',
  dance_04: 'Танец 4',
  dance_05: 'Танец 5',
  dance_06: 'Танец 6',
  freaky: 'Странный танец',
  sing_01: 'Пение 1',
  sing_02: 'Пение 2',
  sing_03: 'Пение 3',
  sing_04: 'Пение 4',
  warm_up: 'Разминка',
  'press-up': 'Отжимания',
  cross_body_crunch: 'Скручивания',
  jump_rope_01: 'Скакалка 1',
  jump_rope_02: 'Скакалка 2',
  golf: 'Гольф',
  surf: 'Сёрфинг',
  volleyball: 'Волейбол',
  basketball_shot: 'Бросок в баскетболе',
  dribble: 'Дриблинг',
  crossover_dribble: 'Кроссовер',
  football_catch: 'Ловля мяча',
  football_pass: 'Пас',
  football_save: 'Сейв вратаря',
  pitch_baseball: 'Подача в бейсболе',
};

const BIPED_GROUPS: Readonly<Record<string, readonly string[]>> = {
  [STANCE]: [
    'idle',
    'standing_relax',
    'wait',
    'look_around',
    'fold_arms',
    'scratch',
    'depressed',
  ],
  [MOVE]: [
    'walk',
    'run',
    'run_upstairs',
    'turn',
    'jump',
    'jump_down',
    'fall',
    'climb',
    'dive',
    'flip',
    'swim',
    'swagger',
  ],
  [DAMAGE]: [
    'hurt',
    'hit_to_body_01',
    'hit_to_body_02',
    'hit_to_head',
    'hit_to_side',
    'hit_to_stomach',
    'flee_01',
    'flee_02',
    'afraid',
    'frightened',
    'scared_01',
    'scared_02',
    'defeat_02',
    'defeat_03',
  ],
  [COMBAT]: [
    'shoot',
    'fire',
    'slash',
    'chop',
    'box_01',
    'box_02',
    'box_03',
    'front_kick_01',
    'front_kick_02',
    'cast_a_spell',
  ],
  [WORK]: [
    'lift_heavy',
    'shovel',
    'dig',
    'sit',
    'make_a_call_01',
    'make_a_call_02',
    'play_mobile_game',
    'play_video_game',
  ],
  [EMOTION]: [
    'agree',
    'angry_01',
    'angry_02',
    'angry_03',
    'complain_01',
    'complain_02',
    'frustrated_01',
    'frustrated_02',
    'cry',
    'sob',
    'laugh_01',
    'laugh_02',
    'cheer',
    'clap',
    'greet_01',
    'greet_02',
    'greet_03',
    'greet_04',
    'wave_goodbye_01',
    'wave_goodbye_02',
    'bow',
    'hug',
    'heart_pose',
    'victory_celebration',
  ],
  [SPORT]: [
    'dance_01',
    'dance_02',
    'dance_03',
    'dance_04',
    'dance_05',
    'dance_06',
    'freaky',
    'sing_01',
    'sing_02',
    'sing_03',
    'sing_04',
    'warm_up',
    'press-up',
    'cross_body_crunch',
    'jump_rope_01',
    'jump_rope_02',
    'golf',
    'surf',
    'volleyball',
    'basketball_shot',
    'dribble',
    'crossover_dribble',
    'football_catch',
    'football_pass',
    'football_save',
    'pitch_baseball',
  ],
};

/**
 * Движения скелета человека (v1.0) в порядке групп для галереи. Идентификатор —
 * полный `preset:biped:<имя>`: короткая форма у Tripo есть не для всех движений.
 */
export const MOTIONS_V1: readonly Motion[] = Object.entries(BIPED_GROUPS).flatMap(([group, names]) => {
  return names.map((name) => ({
    id: `preset:biped:${name}`,
    label: BIPED_LABELS[name] ?? name,
    group,
  }));
});

const GENERAL = 'Общие';
const CREATURE = 'Для своего типа тела';

// Одиннадцать движений скелета v2.5 подходят любому типу тела.
const MOTIONS_V2_GENERAL: readonly Motion[] = [
  ['idle', 'Покой'],
  ['walk', 'Ходьба'],
  ['run', 'Бег'],
  ['dive', 'Нырок'],
  ['climb', 'Лезть вверх'],
  ['jump', 'Прыжок'],
  ['slash', 'Рубящий удар'],
  ['shoot', 'Выстрел'],
  ['hurt', 'Ранение'],
  ['fall', 'Падение'],
  ['turn', 'Поворот'],
].map(([name, label]) => ({
  id: `preset:${name}`,
  label: label ?? '',
  group: GENERAL
}));

// Собственное движение типа тела: есть у пяти типов из семи.
const MOTIONS_V2_CREATURE: Readonly<Record<string, Motion>> = {
  quadruped: {
    id: 'preset:quadruped:walk',
    label: 'Ходьба на четырёх лапах',
    group: CREATURE
  },
  hexapod: {
    id: 'preset:hexapod:walk',
    label: 'Ходьба на шести лапах',
    group: CREATURE
  },
  octopod: {
    id: 'preset:octopod:walk',
    label: 'Ходьба на восьми лапах',
    group: CREATURE
  },
  serpentine: {
    id: 'preset:serpentine:march',
    label: 'Ползти',
    group: CREATURE
  },
  aquatic: {
    id: 'preset:aquatic:march',
    label: 'Плыть',
    group: CREATURE
  },
};

/**
 * Движения скелета существ (v2.5) для типа тела: общие и, если есть, своё.
 * Чужое движение типа тела не предлагается — Tripo отклонит его заказ.
 */
export function motionsV2(rigType: string): Motion[] {
  const own = MOTIONS_V2_CREATURE[rigType];

  return own ? [...MOTIONS_V2_GENERAL, own] : [...MOTIONS_V2_GENERAL];
}

/**
 * Все известные движения обоих скелетов — для подписи версии по id движения,
 * в том числе у заказов агентов, сделанных вне раздела.
 */
export function motionLabel(id: string): string {
  const known = [...MOTIONS_V1, ...MOTIONS_V2_GENERAL, ...Object.values(MOTIONS_V2_CREATURE)];

  return known.find((motion) => motion.id === id)?.label ?? id.split(':').at(-1) ?? id;
}
