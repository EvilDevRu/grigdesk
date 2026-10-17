// Общий каркас контрактов разделов: проверка сетевого JSON и вывод типов из той же
// записи. Раздел описывает форму своих данных, а как именно проверяется строка, число
// или список — живёт здесь в одном экземпляре. До этого модуля каркас был скопирован
// в каждый контракт, и копии начали расходиться (одна знала булевы перечисления,
// другая нет), хотя чинить такое приходится сразу во всех.
//
// Класс ошибки остаётся у раздела: по нему ловят отказ его тесты, и текст сообщения
// называет человеку именно тот раздел, чей ответ не подошёл.

export type Decoder<Value> = (value: unknown, path: string) => Value;
export type Fields = Record<string, Decoder<unknown>>;
export type Decoded<Shape extends Fields> = {
  [Key in keyof Shape]: ReturnType<Shape[Key]>;
};

/**
 * Набор проверок для одного раздела. `fail` бросает ошибку этого раздела и никогда
 * не возвращает управление — поэтому декодеры могут заканчиваться им же, а не
 * придумывать запасное значение для непонятного JSON.
 */
export function contractDecoders(fail: (path: string) => never) {
  /**
   * На входе сети допускается только обычный JSON-объект. После проверки его поля
   * остаются unknown, пока соответствующий декодер не подтвердит их форму.
   */
  function record(value: unknown, path: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      fail(path);
    }

    return value as Record<string, unknown>;
  }

  /**
   * Объект собирается только из объявленных и проверенных полей: динамический обход
   * ключей связан с mapped type приведением результата, а входящий JSON доверенным
   * не объявляется.
   */
  function objectOf<Shape extends Fields>(fields: Shape): Decoder<Decoded<Shape>> {
    return (value, path) => {
      const source = record(value, path);
      const entries = Object.entries(fields).map(([key, decode]) => [
        key,
        decode(source[key], `${path}.${key}`),
      ]);

      return Object.fromEntries(entries) as Decoded<Shape>;
    };
  }

  function text(value: unknown, path: string): string {
    if (typeof value !== 'string') {
      fail(path);
    }

    return value;
  }

  // Число как величина: NaN и бесконечности сюда не проходят.
  function numeric(value: unknown, path: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail(path);
    }

    return value;
  }

  // Число как счёт: размеры, длины и номера строк не бывают дробными и отрицательными.
  function wholeNumber(value: unknown, path: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      fail(path);
    }

    return value;
  }

  function boolean(value: unknown, path: string): boolean {
    if (typeof value !== 'boolean') {
      fail(path);
    }

    return value;
  }

  /**
   * Перечислением закрыты значения, которые управляют кнопками и ветками показа:
   * незнакомое состояние не должно тихо включать запасную ветку. Числа сюда входят
   * наравне со строками: ступень приоритета — такой же закрытый набор, как и статус,
   * и «приоритет 7» должен отвергаться, а не молча доезжать до формы.
   */
  function oneOf<const Values extends readonly (string | number | boolean)[]>(
    ...values: Values
  ): Decoder<Values[number]> {
    return (value, path) => {
      for (const expected of values) {
        if (value === expected) {
          return expected;
        }
      }

      return fail(path);
    };
  }

  function nullable<Value>(decode: Decoder<Value>): Decoder<Value | null> {
    return (value, path) => (value === null ? null : decode(value, path));
  }

  /**
   * Поля, которого может не быть вовсе: старая запись на диске, ответ модели без
   * необязательного поля, свежий признак у прежних данных. Отсутствие и null здесь
   * одно и то же — раздел показывает такое поле пустым местом, а не отказом.
   */
  function optional<Value>(decode: Decoder<Value>): Decoder<Value | null> {
    return (value, path) => (
      value === undefined || value === null ? null : decode(value, path)
    );
  }

  function listOf<Value>(decode: Decoder<Value>): Decoder<Value[]> {
    return (value, path) => {
      if (!Array.isArray(value)) {
        fail(path);
      }

      return (value as unknown[]).map((item, index) => decode(item, `${path}[${index}]`));
    };
  }

  // Словарь с неизвестными заранее ключами: значения всё равно проходят свой декодер.
  function mapOf<Value>(decode: Decoder<Value>): Decoder<Record<string, Value>> {
    return (value, path) => Object.fromEntries(Object.entries(record(value, path))
      .map(([key, item]) => [key, decode(item, `${path}.${key}`)]));
  }

  return {
    boolean,
    listOf,
    mapOf,
    nullable,
    numeric,
    objectOf,
    optional,
    oneOf,
    record,
    text,
    wholeNumber,
  };
}
