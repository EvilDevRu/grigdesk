// Реестр голосовых движков.
//
// Наружу отдаются только возможности и описание голосов: как именно адаптер ходит
// к своему движку — его дело, а ключи и адреса поставщиков остаются серверными
// настройками. Интерфейс получает статус, а не способ подключения.
//
// В первом выпуске подключён один адаптер. Это осознанное ограничение плана:
// сравнение движков — отдельный эксперимент, а выпуск не должен ждать его исхода.
import type { VoiceDoctor, VoiceEngine, VoiceInfo } from './contract.ts';
import { createRhvoiceEngine } from './rhvoice.ts';
import { ShowcaseError } from '../errors.ts';

export interface VoiceEngineStatus {
  id: string;
  name: string;
  kind: VoiceEngine['kind'];
  doctor: VoiceDoctor;
  voices: VoiceInfo[];
}

export function createVoiceRegistry(engines: VoiceEngine[] = [createRhvoiceEngine()]) {
  function list(): VoiceEngine[] {
    return engines;
  }

  function engineOf(id: string): VoiceEngine {
    const engine = engines.find((item) => item.id === id);

    if (!engine) {
      throw new ShowcaseError('unknown_voice_engine', `Голосовой движок «${id}» не подключён.`, 400);
    }

    return engine;
  }

  /**
   * Состояние всех движков для интерфейса. Отказ одного адаптера не закрывает
   * список: человеку нужно видеть и то, что недоступно, вместе с причиной —
   * иначе выбор выглядит как «движков нет вовсе».
   */
  async function statuses(): Promise<VoiceEngineStatus[]> {
    const result: VoiceEngineStatus[] = [];

    for (const engine of engines) {
      const doctor = await engine.doctor().catch((error: unknown) => ({
        status: 'unknown' as const,
        reason: error instanceof Error ? error.message : 'Движок не отвечает.',
        install: '',
      }));
      const voices = doctor.status === 'ready'
        ? await engine.voices().catch(() => [])
        : await engine.voices().catch(() => []);

      result.push({
        id: engine.id,
        name: engine.name,
        kind: engine.kind,
        doctor,
        voices,
      });
    }

    return result;
  }

  /**
   * Разбор ссылки на голос: `<движок>:<голос>`. Ссылка хранится в сцене, поэтому
   * форма у неё строгая — иначе смена движка молча оставила бы прежнее имя голоса
   * и синтез пошёл бы чужим.
   */
  function parseVoiceRef(voiceRef: string): { engineId: string; voiceId: string } {
    const [engineId, voiceId] = voiceRef.split(':');

    if (!engineId || !voiceId) {
      throw new ShowcaseError('bad_voice_ref', 'Голос указывается как «движок:голос».', 400);
    }

    return { engineId, voiceId };
  }

  return { engineOf, list, parseVoiceRef, statuses };
}

export type VoiceRegistry = ReturnType<typeof createVoiceRegistry>;
