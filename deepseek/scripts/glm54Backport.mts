export const GLM_54_BACKPORT_ENV = 'GRIGDESK_DEEPSEEK_GLM_54_BACKPORT';
export const GLM_54_BACKPORT_PATCH = 'deepseek/build/optional-patches/glm54-models.patch';

/**
 * Опциональный патч рассчитан на конкретный снимок Harness 0.1.5-rc.2.
 * Этот же предикат определяет, когда ctl предлагает включить патч.
 */
export function glm54BackportApplicable(source: { version: string; commit: string }): boolean {
  return source.version === '0.1.5-rc.2' && source.commit === 'c291e7961a515f6d7af9304e7fd1d257929aef26';
}

/**
 * Для сборки нужны и подходящий снимок, и явное включение в окружении.
 * Старый флаг можно оставить при обновлении снимка, сборка всё равно его пропустит.
 */
export function glm54BackportEnabled(source: { version: string; commit: string }): boolean {
  return process.env[GLM_54_BACKPORT_ENV] === '1' && glm54BackportApplicable(source);
}
