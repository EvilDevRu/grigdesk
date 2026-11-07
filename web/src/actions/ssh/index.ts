// Единственная точка входа раздела SSH для видов: состояние берётся из стора, а всё,
// что связано с сетью, паролем и каналом терминала, — из операций. Одна операция —
// один файл: то, что меняется по причине транспорта, не живёт рядом с состоянием.
export { useSshStore } from '../../stores/ssh.ts';

export { loadSsh, loadSshProjects, reloadSshAudit } from './loadSsh.ts';
export {
  connectSshSession,
  decideSshHostKey,
  probeSshHostKey,
  saveSshConnection,
} from './sshConnections.ts';
export { closeSshSession, setSshAgentAccess } from './sshSessions.ts';
export { listSshFiles, sshDownloadUrl, uploadSshFile } from './sshFiles.ts';
export {
  activateSshSession,
  bindSshTerminal,
  detachSshTerminal,
  resizeSshTerminal,
  sendSshInput,
  useSshSocketFactory,
} from './sshTerminal.ts';
export { watchSsh } from './watchSsh.ts';
