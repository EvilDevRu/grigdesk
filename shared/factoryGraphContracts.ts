// Схема конвейера, какой её строит сервер (`buildRouteDef`).
//
// Одну и ту же схему рисуют две страницы: живая задача и просмотр опубликованного
// маршрута. Поэтому её форма объявлена здесь, а не внутри компонента: `<script setup>`
// ничего не экспортирует, и второй потребитель был вынужден называть схему «чем-то».
//
// Позиции, узлы и рёбра приходят кортежами — так их отдаёт движок, и переписывать их
// в объекты значило бы завести второй формат ради вкуса. Кортежи читаются позиционно
// самим компонентом, поэтому проверяются здесь только контейнеры: подменённый тип
// корня — это сломанный ответ, а лишний элемент кортежа компонент просто не читает.

import { contractDecoders } from './contractDecoders.ts';

export class FactoryGraphContractError extends Error {
  constructor(path: string) {
    super(`Некорректная схема конвейера: поле ${path}`);
    this.name = 'FactoryGraphContractError';
  }
}

const { record } = contractDecoders((path) => {
  throw new FactoryGraphContractError(path);
});

export type GraphPosition = [number, number];

// [подпись, подзаголовок?, класс?] — второй и третий элементы необязательны.
export type GraphNodeDefinition = [string, string?, string?];

// [откуда, куда, вид, подпись, класс?]
export type GraphEdge = [string, string, string, string, string?];

export type LabelPosition = [number, number] | null;

// Исполнитель узла: остальные поля читает подпись, поэтому запись открыта.
export interface RunnerMetadata extends Record<string, unknown> {
  switched?: boolean;
}

export interface GraphNodeMetadata {
  runner?: RunnerMetadata;
}

// Остановка приходит из соседнего контракта и разбирается своим модулем: здесь она
// остаётся непроверенной, чтобы форма остановки не была объявлена дважды.
export interface FactoryGraphData {
  pos: Record<string, GraphPosition>;
  nodes: Record<string, GraphNodeDefinition>;
  edges: GraphEdge[];
  statuses?: Record<string, string>;
  loops?: Record<string, number>;
  nodeMeta?: Record<string, GraphNodeMetadata>;
  stall?: unknown;
}

// Идущий разбор арбитра: не свойство графа, а отдельный живой факт задачи.
export interface ArbiterRun {
  actor?: string;
  model?: string | null;
  elapsedSec?: number;
}

/**
 * Проверяет корни схемы. Без узлов и рёбер рисовать нечего, и молча показать пустое
 * полотно хуже отказа: человек решит, что маршрут пуст, хотя ответ просто сломан.
 */
export function parseFactoryGraph(value: unknown, path = 'graph'): FactoryGraphData {
  const graph = record(value, path);

  record(graph.pos, `${path}.pos`);
  record(graph.nodes, `${path}.nodes`);

  if (!Array.isArray(graph.edges)) {
    throw new FactoryGraphContractError(`${path}.edges`);
  }

  return graph as unknown as FactoryGraphData;
}
