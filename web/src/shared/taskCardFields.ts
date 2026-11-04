import { isRecord } from '../../../shared/lib/objects.ts';

interface ChecklistNode {
  id: string;
  parentId: string;
  title: string;
  sortIndex: number;
  complete: boolean;
  important: boolean;
  children: ChecklistNode[];
}

export interface ChecklistRow {
  id: string;
  title: string;
  complete: boolean;
  important: boolean;
  depth: number;
}

/**
 * Аватар загружается только по абсолютному HTTPS URL без встроенных реквизитов.
 * Ошибочные и небезопасные адреса оставляют имя пользователя без изображения.
 */
export function taskAvatar(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  try {
    const url = new URL(value);

    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

/**
 * REST присылает участников массивом либо картой по идентификатору сотрудника.
 * Неизвестные записи пропускаются, чтобы чужое расширение не ломало карточку.
 */
export function taskPeopleNames(value: unknown): string {
  const people = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];

  return people.filter(isRecord).map((person) => person.name)
    .filter((name): name is string => typeof name === 'string' && Boolean(name.trim()))
    .join(', ');
}

/**
 * Редактор использует id из массива участников, а при его отсутствии — из карты данных.
 * Имена и повреждённые записи не становятся номерами сотрудников при сохранении формы.
 */
export function taskPeopleIds(value: unknown, data: unknown): string[] {
  const values = Array.isArray(value) ? value
    : isRecord(data) ? Object.keys(data)
    : Array.isArray(data) ? data.filter(isRecord).map((person) => person.id) : [];

  return [...new Set(values.filter((id) => (typeof id === 'string' || typeof id === 'number')
    && /^\d+$/u.test(String(id)) && Number.isSafeInteger(Number(id)) && Number(id) > 0)
    .map(String))];
}

/**
 * Карта пунктов становится деревом по parentId с сортировкой соседей по sortIndex.
 * Обход без рекурсии сохраняет сирот и циклы по одному разу и не переполняет стек.
 * Строки глубины 0 служат заголовками списков и не участвуют в прогрессе пунктов.
 */
export function taskChecklist(value: unknown): {
  rows: ChecklistRow[];
  complete: number;
  total: number;
} {
  const nodes = new Map<string, ChecklistNode>();
  const entries = isRecord(value) || Array.isArray(value) ? Object.entries(value) : [];

  for (const [key, item] of entries) {
    if (!isRecord(item) || typeof item.title !== 'string') {
      continue;
    }

    const id = String(item.id ?? key);

    nodes.set(id, {
      id,
      parentId: String(item.parentId ?? 0),
      title: item.title,
      sortIndex: Number(item.sortIndex) || 0,
      complete: item.isComplete === 'Y',
      important: item.isImportant === 'Y',
      children: [],
    });
  }

  const sorted = [...nodes.values()].sort((a, b) => a.sortIndex - b.sortIndex);
  const roots: ChecklistNode[] = [];

  for (const node of sorted) {
    const parent = node.parentId !== '0' ? nodes.get(node.parentId) : null;

    if (parent && parent !== node) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const rows: ChecklistRow[] = [];
  const visited = new Set<string>();
  let complete = 0;
  let total = 0;

  for (const root of [...roots, ...sorted]) {
    if (visited.has(root.id)) {
      continue;
    }

    const stack = [{
      node: root,
      depth: 0,
    }];

    while (stack.length) {
      const { node, depth } = stack.pop()!;

      if (visited.has(node.id)) {
        continue;
      }

      visited.add(node.id);
      rows.push({
        id: node.id,
        title: node.title,
        complete: node.complete,
        important: node.important,
        depth,
      });

      if (depth > 0) {
        total += 1;
        complete += Number(node.complete);
      }

      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        stack.push({
          node: node.children[index]!,
          depth: depth + 1,
        });
      }
    }
  }

  return {
    rows,
    complete,
    total,
  };
}
