import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson } from '../../../shared/lib/canonicalJson.ts';
import { readDarwinControlText } from './factoryDarwinRunnerState.ts';

const channelName = /^c_[a-f0-9]{32}$/u;
const attemptName = /^a_[a-f0-9]{32}$/u;
const visitName = /^(?:b|nv)_[a-f0-9]{32}$/u;

/**
 * Отсутствие файла допустимо в физической директории канала. Ошибки доступа,
 * ссылки и повреждённые записи передаются в защитное чтение ownership.
 */
async function readRecord(file: string) {
  try {
    const bytes = await readDarwinControlText(file, 65536);
    const value = JSON.parse(bytes) as Record<string, unknown> | null;

    if (!value || Array.isArray(value) || value.format !== 1) {
      throw new Error('factory_profile_channel_record_invalid');
    }

    return { value, sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

async function checkChannelDirectory(directory: string) {
  const stat = await fs.lstat(directory);

  if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o7777) !== 0o700
    || await fs.realpath(directory) !== directory) {
    throw new Error('factory_profile_channel_path_invalid');
  }
}

/**
 * Обход канала предшествует чтению финализации TX. Профиль может открыть
 * ресурс раньше первой регистрации run, в том числе на SCOUT без TX.
 */
export async function hasPendingDarwinProfileChannel(control: string, task: string, attempt: string) {
  const directory = path.join(control, 'profile-channels', `t${task}`);
  const exists = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    return null;
  });

  if (!exists) {
    return false;
  }

  await checkChannelDirectory(directory);

  const active = await readRecord(path.join(directory, 'active.json'));
  const pending = [];

  for (const channel of await fs.readdir(directory)) {
    if (channel === 'active.json' || channel.startsWith('.checkpoint.')) {
      continue;
    }

    if (!channelName.test(channel)) {
      throw new Error('factory_profile_channel_record_invalid');
    }

    const generation = path.join(directory, channel);

    await checkChannelDirectory(generation);

    const [intent, closed, confirmed, broker] = await Promise.all([
      readRecord(path.join(generation, 'intent.json')),
      readRecord(path.join(generation, 'closed.json')),
      readRecord(path.join(generation, 'closed-confirmed.json')),
      readRecord(path.join(generation, 'broker.json')),
    ]);

    if (!intent) {
      if (closed || confirmed || broker || active?.value.channel === channel) {
        throw new Error('factory_profile_channel_record_invalid');
      }

      continue;
    }

    const owner = intent.value.attempt;
    const visit = intent.value.visit;

    if (intent.value.channel !== channel || intent.value.task !== task || typeof owner !== 'string'
      || !attemptName.test(owner) || typeof visit !== 'string' || !visitName.test(visit)) {
      throw new Error('factory_profile_channel_record_invalid');
    }

    const proof = {
      format: 1,
      channel,
      intentSHA256: intent.sha256,
    };

    if (confirmed && (!closed || closed.value.phase !== 'closed' || closed.value.channel !== channel
      || closed.value.intentSHA256 !== intent.sha256
      || canonicalJson(confirmed.value) !== canonicalJson({ ...proof, closedSHA256: closed.sha256 }))) {
      throw new Error('factory_profile_channel_record_invalid');
    }

    if (!confirmed || active?.value.channel === channel) {
      if (owner !== attempt) {
        throw new Error('factory_profile_channel_identity_changed');
      }

      pending.push({
        ...proof,
        task,
        attempt,
      });
    }
  }

  if (pending.length > 1 || active && canonicalJson(active.value) !== canonicalJson(pending[0])) {
    throw new Error('factory_profile_channel_record_invalid');
  }

  return pending.length === 1;
}
