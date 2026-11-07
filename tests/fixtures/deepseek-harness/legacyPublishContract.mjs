// Замороженный gate contract 1 до binary cutover; неизвестный contract 2 безопасно отвергается.
// Историческая fixture не выбирает и не исполняет runtime, publisher ей не нужен.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const PUBLISH_CONTRACT = '1';

/**
 * Неизвестная версия публикации отвергается старым gate до выбора runtime.
 * Тело сохранено из worker contract1 как историческая характеристика перехода.
 */
export async function legacyRuntimeContract(source) {
  let value;

  try {
    value = JSON.parse(await readFile(path.join(source, 'server/deepseek-runtime-contract.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }

  if (value.format !== 1 || value.publishContract !== Number(PUBLISH_CONTRACT)
      || !['installed', 'embedded'].includes(value.mode)) {
    throw new Error('unsupported_runtime_publish_contract');
  }

  return value;
}

