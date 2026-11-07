/**
 * Dev-мост разрешает только JSON ручки v1, исключая pair и двоичные загрузки.
 * Идентификатор декодируется один раз; скрытые slash, traversal и чужой origin запрещены.
 */
export function allowedRequest(method: string, path: string) {
  if (
    !['GET', 'POST'].includes(method) ||
    typeof path !== 'string' ||
    path.length > 4096 ||
    !path.startsWith('/api/mobile/v1/') ||
    /[\\#\x00-\x20]/.test(path)
  ) {
    return false;
  }

  try {
    const [raw, search = ''] = path.split('?');
    const route = decodeURIComponent(raw!);

    if (/%|\.\.|\/\//.test(route) || route !== raw) {
      return false;
    }

    const read = /^\/api\/mobile\/v1\/(hello|chats|chat-options|attention|waiting|tasks|b24\/tasks|app)$/;
    const detail = new RegExp(
      '^/api/mobile/v1/(' +
        [
          'chats/[A-Za-z0-9_-]{1,64}(/deliveries)?',
          'waiting/[A-Za-z0-9_-]{1,200}/details',
          'tasks/[0-9]+(/plan)?',
          'b24/tasks/[0-9]+(/launch-options)?',
          'operations/[A-Za-z0-9_-]{8,80}',
        ].join('|') +
        ')$',
    );
    const write = new RegExp(
      '^/api/mobile/v1/(' +
        [
          'chats',
          'chats/[A-Za-z0-9_-]{1,64}/(messages|stop|settings|read|workspace(/preview)?)',
          'waiting/[A-Za-z0-9_-]{1,200}',
          'tasks/[0-9]+/(gate|resume|stop)',
          'b24/tasks/[0-9]+/launch',
        ].join('|') +
        ')$',
    );
    const keys = new Set([
      'cursor',
      'before',
      'revision',
      'limit',
      'offset',
      'contentRevision',
      'ids',
    ]);
    const params = new URLSearchParams(search);

    return method === 'POST'
      ? !search && write.test(route)
      : (read.test(route) || detail.test(route)) &&
          [...params.keys()].every((key) => keys.has(key));
  } catch {
    return false;
  }
}
