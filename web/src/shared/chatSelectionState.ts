import { isChatSpeed } from '../../../shared/chat/chatSpeed.ts';
import type { ChatSpeed } from '../../../shared/chat/chatSpeed.ts';
import type { ChatRecord } from './chatContracts.ts';
import type { ChatHistorySnapshot } from './chatHistorySnapshot.ts';

type Group = 'model' | 'effort' | 'mode' | 'speed';
type ModelSelection = Pick<ChatRecord, 'model' | 'modelRef'>;
type ModeSelection = Pick<ChatRecord, 'mode' | 'modeSelection'>;
type Selection = string | ModelSelection | ModeSelection | null;
type Source = ChatRecord | ChatHistorySnapshot;

interface Intent {
  base: Selection;
  value: Selection;
  generation: number;
  modelGeneration?: number;
}

type Choices = Partial<Record<Group, Intent>>;
type Generations = Partial<Record<Group, number>>;

const groups: Group[] = ['model', 'effort', 'mode', 'speed'];

/**
 * Модель сравнивается по сохранённой паре, если она уже известна.
 * Удаление legacy-id сервером не превращает ту же модель в чужую правку.
 */
function modelKey(value: Selection): string {
  if (typeof value === 'string') {
    return value;
  }

  const model = value as ModelSelection;

  return model.modelRef
    ? JSON.stringify([model.modelRef.provider, model.modelRef.model])
    : model.model || '';
}

/**
 * Снимок выбора отделён от реактивного чата и не удерживает его историю.
 * Пустые effort и mode сравниваются одинаково при отсутствии поля в старой схеме.
 */
function read(source: Source, group: Group): Selection {
  if (group === 'speed') {
    return isChatSpeed(source.speed) ? source.speed ?? null : null;
  }

  if (group === 'mode') {
    return { mode: typeof source.mode === 'string' ? source.mode : '',
      modeSelection: source.modeSelection
        ? { ...source.modeSelection as NonNullable<ChatRecord['modeSelection']> } : undefined };
  }
  if (group !== 'model') {
    return typeof source[group] === 'string' ? source[group] as string : '';
  }

  const ref = source.modelRef as ChatRecord['modelRef'];

  return {
    model: typeof source.model === 'string' ? source.model : '',
    modelRef: ref ? { ...ref } : null,
  };
}

/**
 * Маркер выбора и ID режима составляют одну группу CAS и сравниваются вместе.
 * Модель сохраняет прежнее сравнение по modelRef независимо от legacy alias.
 */
function same(group: Group, left: Selection, right: Selection): boolean {
  return group === 'model' ? modelKey(left) === modelKey(right)
    : group === 'mode' ? JSON.stringify(left) === JSON.stringify(right) : left === right;
}

/**
 * Применяется только одна группа настроек: история, черновик и runtime остаются у окна.
 * Пара модели меняется вместе, чтобы legacy-id не расходился с modelRef.
 */
function assign(target: ChatRecord, group: Group, value: Selection): void {
  if (group === 'speed') {
    target.speed = value as ChatSpeed | null;

    return;
  }

  if (group === 'model' || group === 'mode') {
    Object.assign(target, value as ModelSelection);
  } else {
    target[group] = value as string;
  }
}

/**
 * Намерения принадлежат экземпляру окна и живут только до подтверждения записи.
 * Поколение отличает новый выбор от снимка, который уже находится в полёте.
 */
export function createChatSelectionState() {
  const chats = new Map<string, Choices>();
  let generation = 0;

  return {
    /**
     * Первая несохранённая правка запоминает основание для безопасной сверки CAS.
     * Следующие правки меняют желаемое значение, сохраняя исходное основание.
     */
    change(id: string, group: Group, before: Source, after: Source, modelGeneration?: number) {
      const choices = chats.get(id) || {};
      const previous = choices[group];
      const value = read(after, group);

      if (same(group, read(before, group), value)) {
        return previous?.generation;
      }

      const intent: Intent = {
        base: previous ? previous.base : read(before, group),
        value,
        generation: ++generation,
        modelGeneration,
      };

      if (group === 'model' && previous) {
        for (const key of ['effort', 'speed'] as const) {
          if (choices[key]?.modelGeneration === previous.generation) {
            choices[key]!.modelGeneration = intent.generation;
          }
        }
      }

      choices[group] = intent;
      chats.set(id, choices);

      return intent.generation;
    },
    capture(id: string): Generations {
      const choices = chats.get(id);

      return Object.fromEntries(groups.map((group) => [group, choices?.[group]?.generation]));
    },
    newerModel(id: string, sent: Generations): boolean {
      const intent = chats.get(id)?.model;

      return !!intent && intent.generation !== sent.model;
    },
    /**
     * ACK снимает только отправленное поколение; более поздний выбор остаётся dirty.
     * Подтверждённое промежуточное значение становится основанием следующей правки.
     */
    acknowledge(id: string, sent: Generations, confirmed: Source): void {
      const choices = chats.get(id);

      if (!choices) {
        return;
      }

      for (const group of groups) {
        const intent = choices[group];

        if (!intent) {
          continue;
        }
        if (intent.generation === sent[group]) {
          delete choices[group];
        } else {
          intent.base = read(confirmed, group);
        }
      }

      if (!groups.some((group) => choices[group])) {
        chats.delete(id);
      }
    },
    /**
     * Чужое изменение того же поля побеждает как в серверном CAS.
     * Независимые локальные правки сохраняются, а нетронутые поля берутся с сервера.
     */
    rebase(id: string, live: ChatRecord, remote: Source): void {
      const choices = chats.get(id) || {};
      let rejectedModel: number | undefined;

      for (const group of groups) {
        const intent = choices[group];
        const actual = read(remote, group);
        const dependent = (group === 'effort' || group === 'speed') && intent?.modelGeneration !== undefined
          && intent.modelGeneration === rejectedModel;

        if (intent && !dependent
          && (same(group, actual, intent.base) || same(group, actual, intent.value))) {
          intent.base = actual;
          assign(live, group, intent.value);

          continue;
        }
        if (group === 'model' && intent) {
          rejectedModel = intent.generation;
        }

        assign(live, group, actual);
        delete choices[group];
      }

      if (!groups.some((group) => choices[group])) {
        chats.delete(id);
      }
    },
    forget(id: string): void {
      chats.delete(id);
    },
    clear(): void {
      chats.clear();
    },
  };
}
