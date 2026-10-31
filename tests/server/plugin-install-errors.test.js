import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PluginInstallError,
  PLUGIN_INSTALL_ERRORS,
  installError,
  errorInfo,
} from '../../server/src/lib/packageInstall/errors.ts';

test('E1: ошибка адреса имеет безопасный русский текст и HTTP 400', () => {
  const error = installError('source_url_invalid');

  assert.ok(error instanceof PluginInstallError);
  assert.equal(error.code, 'source_url_invalid');
  assert.equal(error.statusCode, 400);
  assert.match(error.message, /Адрес не подходит/u);
});

test('E2: полная таблица содержит все контрактные безопасные отказы', () => {
  const expected = [
    "source_url_invalid",
    "source_kind_unknown",
    "source_unavailable",
    "source_unreachable",
    "source_timeout",
    "source_failed",
    "source_no_versions",
    "version_not_found",
    "version_installed",
    "checkout_mismatch",
    "manifest_missing",
    "manifest_invalid",
    "id_invalid",
    "id_reserved",
    "id_mismatch",
    "api_unsupported",
    "version_invalid",
    "version_mismatch",
    "grigdesk_too_old",
    "web_invalid",
    "symlink_forbidden",
    "submodules_forbidden",
    "package_too_large",
    "npm_dir_invalid",
    "lockfile_missing",
    "dependencies_failed",
    "install_busy",
    "service_closed",
    "job_not_found",
    "job_not_ready",
    "plugin_busy",
    "local_changes",
    "not_managed",
    "no_previous",
    "apply_failed",
    "recovery_required",
    "state_invalid",
    "preview_stale",
    "plugin_stop_required",
    "previous_modified",
    "package_unsupported",
    "workspace_limit",
    "command_output_limit",
    "cancelled",
    "interrupted",
    "internal"
];

  assert.deepEqual(Object.keys(PLUGIN_INSTALL_ERRORS), expected);

  for (const code of expected) {
    const error = installError(code);

    assert.ok(error.statusCode >= 400 && error.statusCode <= 599);
    assert.ok(error.message.length > 0);
    assert.equal(error.message.includes('undefined'), false);
  }
});

test('E3: detail, неизвестный код и сторонняя диагностика имеют строгий контракт', () => {
  assert.equal(installError('plugin_busy', 'идёт замер').message, 'Плагин сейчас занят: идёт замер');
  assert.throws(() => installError('unknown-code'), TypeError);
  assert.throws(() => installError('constructor'), TypeError);
  assert.equal(errorInfo(new Error('fixture-secret')).code, 'internal');
  assert.equal(JSON.stringify(errorInfo(new Error('fixture-secret'))).includes('fixture-secret'), false);
  assert.deepEqual(errorInfo(installError('preview_stale')), {
    code: 'preview_stale',
    message: PLUGIN_INSTALL_ERRORS.preview_stale.message,
  });
});
