import type { MenuItem } from './menu.ts';

/**
 * Способ выбора кандидата явно задаёт границу доверия до ввода каталога или UUID.
 * Все листья передают argv одному dist entry, не читают ключи и не устанавливают сами.
 */
function candidateItem(action: 'check' | 'install', source: 'official' | 'local'): MenuItem {
  const flag = source === 'official' ? '--from' : '--local-run';
  const prompt = `distribution.${source}Prompt`;
  const label = `distribution.${source}`;
  const description = `distribution.${source}Description`;

  if (action === 'check') {
    return {
      label,
      description,
      argv: ['dist', 'check', flag],
      prompt,
    };
  }

  return {
    label,
    description,
    children: ['local', 'remote', 'server'].map((mode) => ({
      label: `distribution.mode.${mode}`,
      description: `distribution.mode.${mode}Description`,
      argv: ['dist', 'install', '--mode', mode, flag],
      prompt,
    })),
  };
}

/**
 * Порядок существующих пунктов не меняется: новая группа добавляется после уборки.
 * Вызывающий показывает её только для исходников; source guard остаётся в самом entry.
 */
export function distributionMenuItem(): MenuItem {
  return {
    label: 'dist',
    description: 'distDescription',
    children: [
      {
        label: 'distribution.build',
        description: 'distribution.buildDescription',
        argv: ['dist', 'build'],
      },
      {
        label: 'distribution.check',
        description: 'distribution.checkDescription',
        children: [candidateItem('check', 'official'), candidateItem('check', 'local')],
      },
      {
        label: 'distribution.install',
        description: 'distribution.installDescription',
        children: [candidateItem('install', 'official'), candidateItem('install', 'local')],
      },
      {
        label: 'distribution.doctor',
        description: 'distribution.doctorDescription',
        argv: ['dist', 'doctor'],
      },
    ],
  };
}
