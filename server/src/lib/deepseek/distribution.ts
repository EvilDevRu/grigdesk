import fs from 'node:fs';

/**
 * Installed промежуточный релиз и embedded cutover отличаются явным контрактом поставки.
 * Повреждённый marker не разрешает fallback на внешнюю установку Harness.
 */
export function deepSeekDistributionMode(file: string): 'installed' | 'embedded' {
  const contract = JSON.parse(fs.readFileSync(file, 'utf8'));

  if (contract.format !== 1 || contract.publishContract !== 1
      || !['installed', 'embedded'].includes(contract.mode)) {
    throw new Error('Повреждён контракт поставки DeepSeek');
  }

  return contract.mode;
}
