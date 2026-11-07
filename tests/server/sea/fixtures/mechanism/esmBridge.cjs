// Внешний bridge: обычный import() из файлового CJS-модуля, без патчинга Node.
'use strict';

module.exports.importUrl = (url) => import(url);
