'use strict';

// Внешний bridge комплекта: обычный import() из файлового CJS-модуля.
// Он лежит рядом с node_modules и не входит в SEA-бандл: Node сам разрешает
// относительные импорты плагина и top-level await, без eval и патчинга.
module.exports.importUrl = (url) => import(url);
