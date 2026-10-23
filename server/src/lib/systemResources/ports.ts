import * as files from 'node:fs/promises';
import { spawn } from 'node:child_process';

export interface ResourcePorts {
  procRoot: string;
  sysRoot: string;
  devRoot: string;
  fs: Pick<typeof files, 'readFile' | 'readdir' | 'realpath' | 'stat' | 'statfs'>;
  spawn: typeof spawn;
}

export type ResourcesOptions = Partial<ResourcePorts>;

/**
 * Системные входы разрешаются один раз на владельца сборщика.
 * Тест может заменить файлы и процесс, не меняя глобальное окружение сервера.
 */
export function resourcePorts(options: ResourcesOptions = {}): ResourcePorts {
  return {
    procRoot: options.procRoot ?? '/proc',
    sysRoot: options.sysRoot ?? '/sys',
    devRoot: options.devRoot ?? '/dev',
    fs: options.fs ?? files,
    spawn: options.spawn ?? spawn,
  };
}

/**
 * Отсутствие файла или доступа означает неизвестное показание.
 * Ошибки необязательных аппаратных источников не выходят в API или журнал.
 */
export async function readText(ports: ResourcePorts, filename: string): Promise<string | undefined> {
  try {
    return (await ports.fs.readFile(filename, 'utf8')).trim();
  } catch {
    return undefined;
  }
}

/**
 * Пустое поле и N/A не превращаются в нулевое измерение.
 * Все опубликованные числа остаются конечными независимо от источника.
 */
export function metricNumber(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : undefined;
}

/**
 * Канонический путь служит идентичностью устройства, а не индекс hwmon/card.
 * Исчезнувшая ссылка просто исключает недоступный источник текущего обхода.
 */
export async function realPath(ports: ResourcePorts, filename: string): Promise<string | undefined> {
  try {
    return await ports.fs.realpath(filename);
  } catch {
    return undefined;
  }
}

/**
 * Исчезновение каталога между опросами эквивалентно пустому списку устройств.
 * Порядок стабилен и не зависит от порядка выдачи файловой системы.
 */
export async function directories(ports: ResourcePorts, filename: string): Promise<string[]> {
  try {
    return (await ports.fs.readdir(filename)).sort();
  } catch {
    return [];
  }
}
