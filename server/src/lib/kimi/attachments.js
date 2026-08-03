import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

export class AttachmentBoundaryError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'AttachmentBoundaryError';
    this.code = code;
    this.details = details;
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeName(value, index) {
  const name = String(value ?? '').normalize('NFC');
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new AttachmentBoundaryError('invalid_attachment_name', { index });
  }
  return `${String(index).padStart(3, '0')}-${name.replace(/[^\p{L}\p{N}._ -]/gu, '_')}`;
}

/**
 * Источник никогда не монтируется в sandbox. Сначала читаем уже открытый fd с
 * O_NOFOLLOW в private staging; /proc/self/fd фиксирует фактически открытый inode.
 */
export async function stageKimiAttachments({
  allowedRoot,
  manifest = [],
  stagingParent,
  limits = {},
}) {
  const maxCount = limits.maxCount ?? 16;
  const maxFileBytes = limits.maxFileBytes ?? 8 * 1024 * 1024;
  const maxTotalBytes = limits.maxTotalBytes ?? 32 * 1024 * 1024;
  if (!Array.isArray(manifest) || manifest.length > maxCount) {
    throw new AttachmentBoundaryError('attachment_count_limit');
  }
  const rootReal = await fs.realpath(allowedRoot);
  const parentReal = await fs.realpath(stagingParent);
  const stagingDir = await fs.mkdtemp(path.join(parentReal, 'kimi-run-'));
  await fs.chmod(stagingDir, 0o700);
  const files = [];
  let totalBytes = 0;
  const ids = new Set();

  try {
    for (const [index, item] of manifest.entries()) {
      if (!item || typeof item.sourcePath !== 'string' || !path.isAbsolute(item.sourcePath)) {
        throw new AttachmentBoundaryError('invalid_attachment_path', { index });
      }
      if (ids.has(item.id)) throw new AttachmentBoundaryError('duplicate_attachment_id', { id: item.id });
      ids.add(item.id);
      const sourceLstat = await fs.lstat(item.sourcePath);
      if (sourceLstat.isSymbolicLink()) throw new AttachmentBoundaryError('attachment_symlink', { index });
      const expectedReal = await fs.realpath(item.sourcePath);
      if (!isWithin(rootReal, expectedReal)) throw new AttachmentBoundaryError('attachment_outside_root', { index });

      const handle = await fs.open(item.sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (!before.isFile()) throw new AttachmentBoundaryError('attachment_not_regular', { index });
        if (before.size > maxFileBytes) throw new AttachmentBoundaryError('attachment_file_limit', { index });
        totalBytes += before.size;
        if (totalBytes > maxTotalBytes) throw new AttachmentBoundaryError('attachment_total_limit');

        const openedReal = await fs.realpath(`/proc/self/fd/${handle.fd}`);
        if (openedReal !== expectedReal || !isWithin(rootReal, openedReal)) {
          throw new AttachmentBoundaryError('attachment_changed_during_open', { index });
        }
        const content = await handle.readFile();
        const after = await handle.stat();
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
          throw new AttachmentBoundaryError('attachment_changed_during_copy', { index });
        }
        const filename = safeName(item.name ?? path.basename(item.sourcePath), index);
        const destination = path.join(stagingDir, filename);
        await fs.writeFile(destination, content, { mode: 0o400, flag: 'wx' });
        files.push({ id: item.id, filename, sandboxPath: `/attachments/${filename}`, size: content.length });
      } finally {
        await handle.close();
      }
    }
    await fs.chmod(stagingDir, 0o500);
    return {
      stagingDir,
      files,
      totalBytes,
      cleanup: async () => {
        // Staging read-only для runtime, но владелец обязан вернуть write bit
        // перед удалением; иначе успешный run сам оставит мусор.
        await fs.chmod(stagingDir, 0o700).catch(() => {});
        await fs.rm(stagingDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}
