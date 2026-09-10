// Загрузка файлов на Диск Битрикса через тот же сессионный аплоадер, что и веб-морда.
//
// Браузер грузит вложения комментариев/задач через generic-контроллер
// `ui.fileuploader.upload`, указывая дисковый контроллер интеграции
// `disk.uf.integration.diskUploaderController`. Подпись не нужна — доступ
// авторизуется по сессии (файл кладётся в «Мой Диск / Загруженные файлы»
// текущего пользователя). Ответ возвращает serverFileId вида `n<diskObjectId>` —
// именно его веб-морда подставляет в скрытые поля вложений
// (`UF_FORUM_MESSAGE_DOC[]` у комментария, `UF_TASK_WEBDAV_FILES[]` у задачи).
//
// Протокол (разобран из /bitrix/js/ui/uploader/core/dist/ui.uploader.bundle.min.js):
//   POST /bitrix/services/main/ajax.php
//        ?action=ui.fileuploader.upload
//        &controller=disk.uf.integration.diskUploaderController
//        &controllerOptions=&token=<пусто|токен предыдущего чанка>&sessid=<bitrix_sessid>
//   Заголовки: Content-Type: <mime>, X-Upload-Content-Name: <urlencode(имя)>,
//              для многочанковой загрузки — Content-Range: bytes <от>-<до>/<всего>
//   Тело: сырые байты файла (НЕ multipart).

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

// Контроллер дисковой интеграции аплоадера (имя действия для ui.fileuploader).
export const DISK_UPLOADER_CONTROLLER = 'disk.uf.integration.diskUploaderController';

// Размер чанка — как defaultChunkSize портала (10 МБ). Файлы меньше шлём одним запросом.
export const UPLOAD_CHUNK_SIZE = 10 * 1024 * 1024;

// Сигнатуры (магические байты) распространённых типов — определяем mime по содержимому.
const MAGIC = [
    { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
    { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
    { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
    { mime: 'image/bmp', bytes: [0x42, 0x4d] },
    { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
];

// Фоллбэк по расширению, если по содержимому не опознали.
const MIME_BY_EXT = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    jpe: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    txt: 'text/plain',
    srt: 'application/x-subrip',
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
};

/**
 * Определяет mime-тип по магическим байтам, затем по расширению имени.
 * По умолчанию — application/octet-stream (диск Битрикса принимает любой файл).
 */
export function detectMime(name, buffer) {
    for (const sig of MAGIC) {
        if (buffer.length >= sig.bytes.length && sig.bytes.every((b, i) => buffer[i] === b)) {
            return sig.mime;
        }
    }
    // MP4/MOV: контейнер ISO-BMFF помечен боксом 'ftyp' со смещения 4. Тип важен:
    // с application/octet-stream портал показывает вложение файлом «скачать», а
    // фрагмент записи прикладывают затем, чтобы его посмотрели, не выходя из задачи.
    if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
        const brand = buffer.subarray(8, 12).toString('ascii');
        return brand.startsWith('qt') ? 'video/quicktime' : 'video/mp4';
    }
    // WEBP: 'RIFF'....'WEBP'
    if (
        buffer.length >= 12 &&
        buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
        buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
        return 'image/webp';
    }
    const ext = (name.split('.').pop() || '').toLowerCase();
    return MIME_BY_EXT[ext] || 'application/octet-stream';
}

/**
 * Читает источник файла в буфер. Принимает путь на диске ИЛИ готовый Buffer
 * (плюс base64-строку — на случай, если байты приходят не из файла).
 * @returns {{ buffer: Buffer, name: string }}
 */
export function readFileSource({ path = null, buffer = null, base64 = null, name = null }) {
    if (buffer) {
        return { buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer), name: name || 'file' };
    }
    if (base64) {
        return { buffer: Buffer.from(base64, 'base64'), name: name || 'file' };
    }
    if (path) {
        return { buffer: readFileSync(path), name: name || basename(path) || 'file' };
    }
    throw new Error('Не указан источник файла (path/buffer/base64)');
}
