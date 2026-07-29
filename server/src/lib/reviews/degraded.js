// Fail-closed facade: сбой review-state не должен ронять чаты и остальные разделы,
// но ни чтение ревью, ни изменение Project binding нельзя выдавать за успешное.
export function createDegradedReviewService(cause) {
  const detail = String(cause?.message || cause || 'Review subsystem не инициализирован')
    .slice(0, 2_000);
  const unavailable = async () => {
    const error = new Error('Подсистема ревью временно недоступна');
    error.code = 'REVIEW_SUBSYSTEM_UNAVAILABLE';
    error.statusCode = 503;
    error.details = { cause: cause?.code || 'REVIEW_INIT_FAILED' };
    throw error;
  };
  return Object.freeze({
    degraded: true,
    degradedReason: detail,
    init: unavailable,
    snapshot: unavailable,
    summary: unavailable,
    sync: unavailable,
    markRead: unavailable,
    analyze: unavailable,
    setScope: unavailable,
    run: unavailable,
    getRun: unavailable,
    accept: unavailable,
    publish: unavailable,
    abandon: unavailable,
    cleanup: unavailable,
    projectStatus: unavailable,
    assertRepositoryMutable: unavailable,
    mutateRepositoryConfiguration: unavailable,
    close: async () => {},
  });
}
