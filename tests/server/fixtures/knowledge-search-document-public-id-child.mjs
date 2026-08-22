// Дочерняя фикстура управляемо прерывает или задерживает публикацию ключа публичного идентификатора документа.
import { Buffer } from 'node:buffer';

import {
  DocumentPublicIdKeyStore,
  deriveDocumentPublicIdKeyId,
} from '../../../server/src/lib/search/document-public-id.js';

const [file, rawSeed, crashStep = '', holdStep = ''] = process.argv.slice(2);
const seed = Number.parseInt(rawSeed, 10);

if (!file || !Number.isInteger(seed) || seed < 1 || seed > 255 || !process.send) {
  process.exitCode = 2;
} else {
  const candidate = Buffer.alloc(32, seed);
  process.send({
    type: 'ready',
    candidateKeyId: deriveDocumentPublicIdKeyId(candidate),
  });

  process.once('message', async (message) => {
    if (message?.type !== 'start') {
      process.exitCode = 2;
      process.disconnect();
      return;
    }
    try {
      const material = await new DocumentPublicIdKeyStore({
        file,
        random(size) {
          if (size !== candidate.length) throw new Error('unexpected key size');
          return candidate;
        },
        publicationObserver(step, details) {
          return new Promise((resolve) => {
            process.send({ type: 'publication-step', step, details }, () => {
              if (step === crashStep) {
                process.kill(process.pid, 'SIGKILL');
                return;
              }
              if (step !== holdStep) {
                resolve();
                return;
              }
              const resume = (resumeMessage) => {
                if (resumeMessage?.type !== 'resume-publication-step'
                    || resumeMessage?.step !== step) return;
                process.off('message', resume);
                resolve();
              };
              process.on('message', resume);
            });
          });
        },
      }).initialize();
      process.send({ type: 'result', keyId: material.keyId }, () => process.disconnect());
    } catch (error) {
      process.send({
        type: 'failure',
        code: error?.code || 'unknown',
        message: error?.message || String(error),
        details: error?.details || null,
      }, () => {
        process.exitCode = 1;
        process.disconnect();
      });
    }
  });
}
