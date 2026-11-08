import fs from 'node:fs/promises';
import path from 'node:path';

import { isRecord } from '../shared/lib/objects.ts';
import { canonicalJson } from '../shared/lib/canonicalJson.ts';
import { parseProductVersion } from '../shared/runtime/productReleaseVersion.ts';

interface ChecksInput {
  testMode: string;
  reason: string;
  validationRun: string;
  version: string;
  commit: string;
  ref: string;
}

/**
 * Пропуск требует явного выбора и причины; обычный запуск всегда выполняет полный набор.
 * Версия и канал не подменяют решение владельца при ручном запуске workflow.
 */
export function resolveReleaseChecks(input: ChecksInput) {
  const version = parseProductVersion(input.version);

  if (!version || !/^[a-f0-9]{40}$/u.test(input.commit)
    || !['full', 'skip'].includes(input.testMode)
    || (version.dev === null ? !['refs/heads/main', `refs/tags/v${input.version}`].includes(input.ref)
      : input.ref !== 'refs/heads/dev')) {
    throw new Error('release_checks_input_invalid');
  }

  if (input.validationRun && !/^[1-9][0-9]*$/u.test(input.validationRun)) {
    throw new Error('release_checks_validation_invalid');
  }

  const reason = input.reason.trim();

  if (input.testMode === 'skip') {
    if (input.validationRun || !reason || reason.length > 1000) {
      throw new Error('release_checks_skip_forbidden');
    }
  } else if (reason) {
    throw new Error('release_checks_unexpected_skip_reason');
  }

  return {
    format: 1,
    mode: input.testMode === 'skip' ? 'skipped' : input.validationRun ? 'reused' : 'full',
    reason: reason || null,
    validationRun: input.validationRun || null,
    version: input.version,
    commit: input.commit,
    ref: input.ref,
  };
}

type ReleaseChecks = ReturnType<typeof resolveReleaseChecks>;

/**
 * Между jobs передаётся строгая запись решения, а не shell-фрагмент из пользовательского ввода.
 * Дополнительные поля, подмена identity и несовместимые режимы не принимаются.
 */
export function decodeReleaseChecks(value: unknown): ReleaseChecks {
  if (!isRecord(value) || typeof value.mode !== 'string'
    || typeof value.version !== 'string' || typeof value.commit !== 'string'
    || typeof value.ref !== 'string' || (value.reason !== null && typeof value.reason !== 'string')
    || (value.validationRun !== null && typeof value.validationRun !== 'string')) {
    throw new Error('release_checks_receipt_invalid');
  }

  const checks = resolveReleaseChecks({
    testMode: value.mode === 'skipped' ? 'skip' : 'full',
    reason: value.reason ?? '',
    validationRun: value.validationRun ?? '',
    version: value.version,
    commit: value.commit,
    ref: value.ref,
  });

  if (canonicalJson(value) !== canonicalJson(checks)) {
    throw new Error('release_checks_receipt_invalid');
  }

  return checks;
}

/**
 * Даже разрешённый пропуск не выдаёт отказавший тест за успешный.
 * Full требует успех обоих jobs; skip/reuse допускают только их фактический пропуск.
 */
export function assertReleaseCheckResults(checks: ReleaseChecks, server: string, web: string): void {
  const expected = checks.mode === 'full' ? 'success' : 'skipped';

  if (server !== expected || web !== expected) {
    throw new Error('release_checks_job_result_invalid');
  }
}

/**
 * Согласованный пропуск виден также в подписанном описании канала.
 * Пользовательская причина остаётся данными JSON и не интерполируется в команды Actions.
 */
export function releaseCheckNotes(checks: ReleaseChecks, source: string): string {
  const notes: unknown = source.trim() ? JSON.parse(source) : { ru: '', en: '' };

  if (!isRecord(notes) || Object.keys(notes).sort().join(',') !== 'en,ru'
    || typeof notes.ru !== 'string' || typeof notes.en !== 'string') {
    throw new Error('release_notes_invalid');
  }

  if (checks.mode === 'skipped') {
    notes.ru += `\n\nПолные CI-тесты пропущены по явному решению владельца. Причина: ${checks.reason}`;
    notes.en += `\n\nFull CI test suites were skipped by explicit release approval. Reason: ${checks.reason}`;
  }

  if (notes.ru.length > 16000 || notes.en.length > 16000) {
    throw new Error('release_notes_invalid');
  }

  return JSON.stringify(notes);
}

/**
 * CLI обслуживает только план, строгие ворота и запись уже принятого решения в acceptance.
 * Он не собирает бинарники, не читает ключи и не выполняет публикацию.
 */
async function main(): Promise<void> {
  const [command, file] = process.argv.slice(2);

  if (!file || !['plan', 'gate', 'attach', 'notes'].includes(command ?? '')) {
    throw new Error('release_checks_usage');
  }

  const checks = command === 'plan' ? resolveReleaseChecks({
    testMode: process.env.TEST_MODE ?? 'full',
    reason: process.env.TEST_SKIP_REASON ?? '',
    validationRun: process.env.VALIDATION_RUN ?? '',
    version: process.env.GRIGDESK_RELEASE_VERSION ?? '',
    commit: process.env.GRIGDESK_RELEASE_COMMIT ?? '',
    ref: process.env.GITHUB_REF ?? '',
  }) : decodeReleaseChecks(JSON.parse(await fs.readFile(file, 'utf8')));

  if (checks.commit !== process.env.GRIGDESK_RELEASE_COMMIT
    || checks.version !== process.env.GRIGDESK_RELEASE_VERSION || checks.ref !== process.env.GITHUB_REF) {
    throw new Error('release_checks_identity_mismatch');
  }

  if (command === 'plan') {
    await fs.writeFile(file, canonicalJson(checks) + '\n');
    await fs.appendFile(process.env.GITHUB_OUTPUT!,
      `run_tests=${checks.mode === 'full'}\nmode=${checks.mode}\n`);
  } else if (command === 'gate') {
    assertReleaseCheckResults(checks, process.env.SERVER_RESULT ?? '', process.env.WEB_RESULT ?? '');

    if (checks.mode === 'reused') {
      const receipt: unknown = JSON.parse(await fs.readFile(path.join(path.dirname(file),
        'validation-receipt.json'), 'utf8'));

      if (!isRecord(receipt) || receipt.currentCommit !== checks.commit
        || receipt.runId !== Number(checks.validationRun)) {
        throw new Error('release_checks_reuse_receipt_invalid');
      }
    }
  } else if (command === 'notes') {
    await fs.appendFile(process.env.GITHUB_ENV!,
      `GRIGDESK_RELEASE_NOTES_JSON=${releaseCheckNotes(checks, process.env.RELEASE_NOTES ?? '')}\n`);
  } else {
    const target = path.join(path.dirname(file), 'release-acceptance.json');
    const acceptance: unknown = JSON.parse(await fs.readFile(target, 'utf8'));

    if (!isRecord(acceptance) || !isRecord(acceptance.identity)
      || acceptance.identity.commit !== checks.commit || acceptance.identity.version !== checks.version) {
      throw new Error('release_checks_acceptance_mismatch');
    }

    acceptance.testValidation = checks;
    await fs.writeFile(target, canonicalJson(acceptance) + '\n');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  await main();
}
