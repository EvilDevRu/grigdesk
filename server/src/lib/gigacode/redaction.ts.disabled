/**
 * Полный секрет скрывается до публикации; незавершённый префикс ждёт следующий chunk.
 * Таблица KMP ограничивает работу линейным размером текста даже для длинного токена.
 */
export function createGigaCodeRedaction(values: string[]) {
  const secrets = [...new Set(values.filter(Boolean))].map((secret) => {
    const prefix = new Uint32Array(secret.length);
    let matched = 0;

    for (let index = 1; index < secret.length; index += 1) {
      while (matched && secret[index] !== secret[matched]) {
        matched = prefix[matched - 1]!;
      }

      if (secret[index] === secret[matched]) {
        matched += 1;
      }

      prefix[index] = matched;
    }

    return { secret, prefix };
  });

  const redact = (value: string) => secrets.reduce(
    (text, item) => text.replaceAll(item.secret, '[скрыто]'), value,
  );

  /**
   * Каждый текстовый канал имеет свой хвост, поэтому thought и answer не смешиваются.
   * Наружу выходит только текст, который уже не может стать частью полного секрета.
   */
  function stream() {
    let pending = '';

    return {
      /**
       * Совмещает предыдущий префикс с новой порцией и скрывает полные совпадения.
       * Хранится только возможное начало секрета, а обычный текст выходит сразу.
       */
      push(chunk: string) {
        const text = redact(pending + chunk);
        let keep = 0;

        for (const { secret, prefix } of secrets) {
          let matched = 0;

          for (let index = 0; index < text.length; index += 1) {
            while (matched && text[index] !== secret[matched]) {
              matched = prefix[matched - 1]!;
            }

            if (text[index] === secret[matched]) {
              matched += 1;
            }

            if (matched === secret.length) {
              matched = prefix[matched - 1]!;
            }
          }

          keep = Math.max(keep, matched);
        }

        pending = keep ? text.slice(-keep) : '';

        return text.slice(0, text.length - keep);
      },
      finish() {
        const text = redact(pending);

        pending = '';

        return text;
      },
    };
  }

  return { redact, stream };
}
