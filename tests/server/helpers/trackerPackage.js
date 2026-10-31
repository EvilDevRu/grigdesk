import { cp, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageVariables = {
  'grigdesk-b24-discript': 'GRIGDESK_CUSTOM_DRIVER_DIR',
  'grigdesk-b24': 'GRIGDESK_STOCK_DRIVER_DIR',
};

// Конечный репозиторий задаётся решением владельца, staging подключается явно через env.
// Тесты не устанавливают пакет и не читают папку данных действующего сервера.
export const customPackageRoot = packageRoot('grigdesk-b24-discript');
export const stockPackageRoot = packageRoot('grigdesk-b24');

/**
 * Каждый настоящий пакет выбирается независимо через env либо соседний репозиторий.
 * Фикстура не создаёт замещающую реализацию и не использует установленный пакет сервера.
 */
function packageRoot(id) {
  const variable = packageVariables[id];

  return path.resolve(process.env[variable]
    || fileURLToPath(new URL(`../../../../grigdesk-desk-drivers/${id}`, import.meta.url)));
}

/**
 * Отсутствие соседнего репозитория пропускает только зависящую от пакета проверку.
 * Явный путь, ошибки доступа и повреждённый пакет остаются ошибками подготовки.
 */
async function preparedPackage(id, t) {
  const directory = id === 'grigdesk-b24' ? stockPackageRoot : customPackageRoot;

  try {
    const info = await stat(directory);

    if (!info.isDirectory()) {
      throw new Error(`Пакет должен быть каталогом: ${directory}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT' || process.env[packageVariables[id]]) {
      throw error;
    }

    t.skip(`пакет не подготовлен: ${directory}`);

    return null;
  }

  return directory;
}

/**
 * Импорт выполняется только после проверки каталога настоящего внешнего пакета.
 * Null сообщает вызывающему тесту, что после t.skip его выполнение нужно завершить.
 */
async function packageModule(id, file, t) {
  const directory = await preparedPackage(id, t);

  return directory ? import(pathToFileURL(path.join(directory, file)).href) : null;
}

/**
 * Копируется только подготовленный пакет, без служебного дерева git.
 * False передаёт skip вверх по цепочке setup, чтобы runtime не запускался без драйвера.
 */
async function copyPackage(id, config, t) {
  const directory = await preparedPackage(id, t);

  if (!directory) {
    return false;
  }

  await cp(directory, path.join(config.driversDir, id), {
    recursive: true,
    filter: (file) => !file.split(path.sep).includes('.git'),
  });

  return true;
}

/**
 * Клиентские protocol-барьеры читают приватный клиент из отдельного репозитория.
 * Отсутствие каталога по умолчанию помечается через контекст зависящего теста.
 */
export function customClientModule(t) {
  return packageModule('grigdesk-b24-discript', 'src/client.ts', t);
}

/**
 * Очередь проверяется на настоящей точке входа драйвера с переданным host.
 * Импорт не подменяет модуль фабрики или сериализатор тестовым двойником.
 */
export function customDriverModule(t) {
  return packageModule('grigdesk-b24-discript', 'driver.ts', t);
}

/**
 * Runtime сканирует копию настоящего пакета только во временном dataDir фикстуры.
 * Git-метаданные репозитория не нужны для импорта и не попадают в тестовую установку.
 */
export function copyCustomPackage(config, t) {
  return copyPackage('grigdesk-b24-discript', config, t);
}

/**
 * Клиентский decoder проверяется на результате настоящего облачного пакета.
 * Импорт внешней точки входа не регистрирует сток как встроенный драйвер ядра.
 */
export function stockDriverModule(t) {
  return packageModule('grigdesk-b24', 'driver.ts', t);
}

/**
 * Сток появляется в каталоге только после установки пакета во временную папку.
 * Реквизиты и транспорт по-прежнему передаются обычным host-контрактом runtime.
 */
export function copyStockPackage(config, t) {
  return copyPackage('grigdesk-b24', config, t);
}

/**
 * Регрессионные проверки чтений импортируют фактическую приватную реализацию пакета.
 * Отсутствие необязательного соседнего пакета сохраняет стандартный skip-контракт.
 */
export function customReadModule(file, t) {
  return packageModule('grigdesk-b24-discript', file, t);
}
