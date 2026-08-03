// Аргументы transient-юнита route-оркестратора (resume после ворот и после возврата).
//
// KillMode=mixed вместо дефолтного control-group — не украшение. Оркестратор по TERM
// обязан сделать три вещи ПО ПОРЯДКУ: остановить активный раннер, снять инструментацию
// (временные логи из рабочего дерева) и только потом умереть. Дефолт шлёт TERM ВСЕМУ
// cgroup сразу, поэтому процессы, которые оркестратор запускает уже внутри обработчика
// сигнала, гибнут вместе с ним: очистка возвращает код 143, задача встаёт в
// STALLED_HUMAN=1, а инструментация остаётся в дереве.
// mixed = TERM только главному процессу (он сам знает, кого и в каком порядке гасить),
// KILL всей группе — уже после TimeoutStopSec, если главный не уложился.
//
// TimeoutStopSec задаём явно: дефолт наследуется от менеджера и в любой момент может
// оказаться меньше, чем стоит снятие инструментации. 120 с — с большим запасом: очистка
// это сравнение снимков файлов и восстановление из бэкапа, секунды.
export function factoryUnitArgs(task) {
  return [
    '--user', '--collect', `--unit=factory-t${task}`,
    '--property=KillMode=mixed', '--property=TimeoutStopSec=120',
  ];
}

// Окружение процесса фабрики. Оно передаётся и обычному detached child, и
// `systemd-run --setenv`: transient scope не обязан наследовать env Cockpit.
export function factoryLaunchEnv(config, extra = {}) {
  return {
    ...extra,
    FACTORY_HOME: config.factoryHome,
    FACTORY_PROFILES_DIR: config.profilesDir,
    FACTORY_STATE: config.stateDir,
    STATE_DIR: config.stateDir,
    FACTORY_CONFIG_ROOT: config.factoryConfigRoot,
  };
}
