interface TabSession {
  id: string;
  projectId?: string;
  label?: string;
  role?: string;
  host?: string;
  port?: number;
}

function targetBase(session: TabSession): string {
  const values = [session.label, session.role]
    .map((value) => String(value || '').trim())
    .filter((value, index, items) => value && items.indexOf(value) === index);

  return values.join(' · ')
    || [session.host, session.port].filter(Boolean).join(':')
    || 'SSH-сессия';
}

/**
 * Панель SSH и подтверждение в чате называют одну вкладку одинаково.
 * Повторные входы одного проекта и назначения различаются порядковым номером.
 */
export function sshSessionTabLabel(session: TabSession, sessions: readonly TabSession[]): string {
  const target = targetBase(session);
  const sameTarget = sessions.filter((item) => (
    item.projectId === session.projectId && targetBase(item) === target
  ));

  if (sameTarget.length < 2) {
    return target;
  }

  const position = sameTarget.findIndex((item) => item.id === session.id) + 1;

  return `${target} · ${Math.max(position, 1)}`;
}
