import { isRecord } from '../lib/objects.ts';
import type { TrackerLabel, TrackerSettingsSchema, TrackerWidget } from './contracts.ts';

/**
 * Подпись допускает только данные или явный ключ общего каталога.
 * HTML, функции и произвольные объекты не проходят границу DTO.
 */
export function isTrackerLabel(value: unknown): value is TrackerLabel {
  return isRecord(value) && (typeof value.text === 'string'
    || (typeof value.key === 'string' && (value.params === undefined || (isRecord(value.params)
      && Object.values(value.params).every((item) =>
        typeof item === 'string' || typeof item === 'number')))));
}

/**
 * Варианты выбора имеют собственные подписи и уникальные непустые значения.
 * Посторонние свойства не проходят границу декларативного контракта.
 */
function isSelectOptions(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }

  const values = new Set<string>();

  return value.every((option) => {
    if (!isRecord(option) || Object.keys(option).some((key) => !['value', 'label'].includes(key))
      || typeof option.value !== 'string' || !option.value.trim() || values.has(option.value)
      || !isTrackerLabel(option.label)) {
      return false;
    }

    values.add(option.value);

    return true;
  });
}

/**
 * Условие видимости сравнивает строку без преобразования типов.
 * Выбор и флаг всегда видимы; произвольные выражения схема не исполняет.
 */
function isFieldVisibility(field: Record<string, unknown>): boolean {
  if (field.visibleIf === undefined) {
    return true;
  }

  const condition = field.visibleIf;

  return !['boolean', 'select'].includes(String(field.type)) && isRecord(condition)
    && Object.keys(condition).every((key) => ['field', 'equals'].includes(key))
    && typeof condition.field === 'string' && Boolean(condition.field.trim())
    && typeof condition.equals === 'string';
}

/**
 * Схема настроек содержит только известные типы и явные подписи данных или каталога.
 * Непроверенное поле пакета не становится настройкой и не определяет выдачу секрета в GET.
 */
export function isTrackerSettingsSchema(value: unknown): value is TrackerSettingsSchema {
  return isRecord(value) && Object.entries(value).every(([key, field]) =>
    /^[a-zA-Z][a-zA-Z0-9_]*$/u.test(key) && !['constructor', 'prototype', '__proto__'].includes(key)
    && isRecord(field) && ['string', 'number', 'boolean', 'select'].includes(String(field.type))
    && Object.keys(field).every((name) =>
      ['type', 'label', 'secret', 'required', 'options', 'visibleIf', 'format'].includes(name))
    && (field.format === undefined || (field.type === 'string' && field.secret === true
      && field.format === 'api-token'))
    && (field.type === 'select' ? isSelectOptions(field.options) : field.options === undefined)
    && isFieldVisibility(field)
    && (field.secret === undefined || typeof field.secret === 'boolean')
    && (field.required === undefined || typeof field.required === 'boolean')
    && (field.label === undefined || isTrackerLabel(field.label)));
}

function isFormat(value: unknown): boolean {
  return value === 'count' || value === 'duration' || value === 'decimal';
}

/**
 * Числовой элемент не получает исполняемое содержимое и бесконечную вложенность.
 * Все числа конечны, прогресс имеет положительный знаменатель.
 */
function isValue(value: unknown, secondary = false): boolean {
  if (!isRecord(value) || typeof value.id !== 'string' || !isTrackerLabel(value.label)
    || typeof value.value !== 'number' || !Number.isFinite(value.value) || !isFormat(value.format)
    || (value.delta !== undefined && (typeof value.delta !== 'number' || !Number.isFinite(value.delta)))) {
    return false;
  }

  if (secondary) {
    return value.progress === undefined && value.secondaryItems === undefined;
  }

  const progress = value.progress;

  return (progress === undefined || (isRecord(progress) && typeof progress.value === 'number'
    && Number.isFinite(progress.value) && typeof progress.max === 'number'
    && Number.isFinite(progress.max) && progress.max > 0))
    && (value.secondaryItems === undefined || (Array.isArray(value.secondaryItems)
      && value.secondaryItems.every((item) => isValue(item, true))));
}

/**
 * Виджеты проверяются целиком до публикации снимка в интерфейсе.
 * Длина ряда совпадает с подписями, неизвестный вид виджета не исполняется.
 */
export function isTrackerWidget(value: unknown): value is TrackerWidget {
  if (!isRecord(value) || typeof value.id !== 'string' || !isTrackerLabel(value.title)) {
    return false;
  }

  if (value.kind === 'kpi') {
    return Array.isArray(value.items) && value.items.every((item) => isValue(item));
  }

  if (value.kind !== 'chart' || !isRecord(value.periods)) {
    return false;
  }

  return Object.entries(value.periods).every(([name, period]) => {
    if (!['day', 'week', 'month'].includes(name) || !isRecord(period)
      || !Array.isArray(period.labels) || !period.labels.every((label) => typeof label === 'string')
      || !Array.isArray(period.series)) {
      return false;
    }

    const count = period.labels.length;

    return period.series.every((series) => isRecord(series) && typeof series.id === 'string'
      && isTrackerLabel(series.label) && isFormat(series.format) && Array.isArray(series.values)
      && series.values.length === count
      && series.values.every((item) => typeof item === 'number' && Number.isFinite(item)));
  });
}
