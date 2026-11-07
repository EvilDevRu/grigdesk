// Внешняя поставка и внутренняя версия различаются в настоящем архиве GitVerse.
// Версии фиксируют проверенную поставку; допуск проверяет имя пакета и ACP v1.
export const GIGACODE_DISTRIBUTION_VERSION = '26.7.33';
export const GIGACODE_PACKAGE_NAME = '@gigacode/gigacode';
export const GIGACODE_PACKAGE_VERSION = '0.13.1';

export const GIGACODE_PACKAGED_UNSUPPORTED = 'В комплекте сервера GigaCode пока не поддерживается';

export interface GigaCodeConfig {
  gigacodeBin?: string;
  gigacodeHome?: string;
  gigacodeRuntimeHome?: string;
  gigacodeBwrapBin?: string;
  // Комплект сервера (SEA) не содержит node и исходников мостов GigaCode.
  gigacodePackaged?: boolean;
}

export interface GigaCodeProbe {
  ok: boolean;
  version: string | null;
  code?: string;
  warning?: string;
}
