import { cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Конечный репозиторий задаётся решением владельца, staging подключается явно через env.
// Тесты не устанавливают пакет и не читают папку данных действующего сервера.
export const customPackageRoot = path.resolve(process.env.GRIGDESK_CUSTOM_DRIVER_DIR
  || fileURLToPath(new URL('../../../../grigdesk-desk-drivers/b24-custom', import.meta.url)));

/**
 * Клиентские protocol-барьеры читают приватный клиент из отдельного репозитория.
 * Core больше не содержит совместимой копии, отсутствие пакета остаётся ошибкой подготовки.
 */
export function customClientModule() {
  return import(pathToFileURL(path.join(customPackageRoot, 'src/client.ts')).href);
}

/**
 * Очередь проверяется на настоящей точке входа драйвера с переданным host.
 * Импорт не подменяет модуль фабрики или сериализатор тестовым двойником.
 */
export function customDriverModule() {
  return import(pathToFileURL(path.join(customPackageRoot, 'driver.ts')).href);
}

/**
 * Runtime сканирует копию настоящего пакета только во временном dataDir фикстуры.
 * Git-метаданные репозитория не нужны для импорта и не попадают в тестовую установку.
 */
export async function copyCustomPackage(config) {
  await cp(customPackageRoot, path.join(config.driversDir, 'b24-custom'), {
    recursive: true,
    filter: (file) => !file.split(path.sep).includes('.git'),
  });
}
