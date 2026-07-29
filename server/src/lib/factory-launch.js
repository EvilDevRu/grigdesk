// Окружение процесса фабрики. Оно передаётся и обычному detached child, и
// `systemd-run --setenv`: transient scope не обязан наследовать env Cockpit.
export function factoryLaunchEnv(config, extra = {}) {
  return {
    ...extra,
    FACTORY_PROFILES_DIR: config.profilesDir,
    FACTORY_STATE: config.stateDir,
    STATE_DIR: config.stateDir,
    FACTORY_CONFIG_ROOT: config.factoryConfigRoot,
  };
}
