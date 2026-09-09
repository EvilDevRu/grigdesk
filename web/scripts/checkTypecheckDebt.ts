// Рубеж общей проверки интерфейса.
//
// Общая проверка web не может быть зелёной, пока крупные разделы держат script на
// JavaScript: их РАЗМЕТКУ компилятор читает всегда, а типов у их же кода ещё нет.
// Поэтому долг записан пофайлово и сверяется: уменьшение требует обновить снимок,
// а любая новая ошибка — отказ. Так «зелёный прогон» не начинает означать «мы
// перестали смотреть».

import { collectTypecheckDebt, readMigrationBaseline } from '../../tools/migrationInventory.mts';

const actual = collectTypecheckDebt();
const expected = readMigrationBaseline().typecheckDebt;
const paths = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
const problems: string[] = [];

for (const path of paths) {
    const was = expected[path] ?? 0;
    const now = actual[path] ?? 0;

    if (now > was) {
        problems.push(`${path}: было ${was}, стало ${now}`);
    } else if (now < was) {
        problems.push(`${path}: долг уменьшился (${was} → ${now}) — обнови снимок остатка`);
    }
}

if (problems.length) {
    process.stderr.write(`Долг общей проверки интерфейса изменился:\n- ${problems.join('\n- ')}\n`);
    process.stderr.write('Снимок: node --experimental-strip-types tools/migrationInventory.mts --write\n');
    process.exitCode = 1;
} else {
    const total = Object.values(actual).reduce((sum, count) => sum + count, 0);

    process.stdout.write(`Общая проверка web: долг ${total} без роста\n`);
}
