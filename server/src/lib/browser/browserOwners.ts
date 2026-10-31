import { randomUUID } from 'node:crypto';

interface OwnerRow {
  owner: string;
  label: string;
}

/**
 * Каталог объединяет только server-owned contributors; UI передаёт opaque ID.
 * Перед каждой передачей/командой данные перечитываются, удалённый чат не оживает из cache.
 */
export function createBrowserOwners() {
  const sources = new Map<string, () => Promise<OwnerRow[]>>();
  const ids = new Map<string, string>();
  const values = new Map<string, string>();

  /**
   * Бounded каталог не превращается в скан сообщений или подсказок интерфейса.
   * Ошибка одного источника запрещает его владельцев, остальные источники сохраняются.
   */
  async function rows() {
    const result: OwnerRow[] = [];

    for (const list of sources.values()) {
      const current = await list().catch(() => []);

      for (const row of current.slice(0, 1000)) {
        if (typeof row.owner !== 'string' || row.owner.length > 1024
          || typeof row.label !== 'string' || !row.label || row.label.length > 160
          || result.some((item) => item.owner === row.owner)) {
          continue;
        }

        result.push(row);
      }
    }

    for (const [owner, id] of ids) {
      if (!result.some((item) => item.owner === owner)) {
        ids.delete(owner);
        values.delete(id);
      }
    }

    return result;
  }

  return {
    register(name: string, list: () => Promise<OwnerRow[]>) {
      if (sources.has(name)) {
        throw new Error('browser_owner_source_conflict');
      }

      sources.set(name, list);

      return () => {
        if (sources.get(name) === list) {
          sources.delete(name);
        }
      };
    },
    async list() {
      return (await rows()).slice(0, 200).map((row) => {
        const id = ids.get(row.owner) ?? randomUUID();

        ids.set(row.owner, id);
        values.set(id, row.owner);

        return { id, label: row.label };
      });
    },
    /**
     * Opaque ID разрешается только через актуальный server-owned каталог.
     * Удалённый владелец не восстанавливается из прежнего отображения ID.
     */
    async resolve(id: string) {
      const owner = values.get(id);
      const current = await rows();

      if (!owner || !current.some((row) => row.owner === owner)) {
        throw new Error('browser_owner_forbidden');
      }

      return owner;
    },
    async exists(owner: string) {
      return (await rows()).some((row) => row.owner === owner);
    },
  };
}
