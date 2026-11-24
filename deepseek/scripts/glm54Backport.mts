export const GLM_54_BACKPORT_ENV = 'GRIGDESK_DEEPSEEK_GLM_54_BACKPORT';
export const GLM_54_BACKPORT_PATCH = 'deepseek/build/optional-patches/glm54-models.patch';

/**
 * Опциональный патч рассчитан на конкретный снимок Harness 0.1.5-rc.2.
 * После обновления снимка сборка пропускает патч, даже если флаг остался в окружении.
 */
export function glm54BackportEnabled(source: { version: string; commit: string }): boolean {
  return process.env[GLM_54_BACKPORT_ENV] === '1'
    && source.version === '0.1.5-rc.2'
    && source.commit === 'c291e7961a515f6d7af9304e7fd1d257929aef26';
}
