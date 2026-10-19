# Асинхронный cache metadata DeepSeek

Async resolver делит один SHA и один metadata процесс между одновременными callers.
Ключ учитывает выбранный absolute path, symlink, realpath и bigint stat самой цели:
dev, ino, size, mode, mtimeNs, ctimeNs, uid и gid. Новая файловая сигнатура требует
нового полного потокового SHA и metadata, даже при прежней upstream version.

Повторная проверка сигнатуры после hash/probe запрещает публикацию изменившегося
executable. Ошибка не возвращает старую identity; появление или исправление файла
видно следующему запросу без рестарта. Поздний отказ A удаляет только собственный
pending entry и не уничтожает уже принятый результат B.

Отмена одного клиента прекращает только его ожидание. Общая проверка остаётся
ограниченной timeout и пригодна для остальных клиентов; AbortSignal не прерывает
их shared probe. Heartbeat продолжает работать во время медленной metadata проверки.

Security profile, catalog key и native settings context ждут async descriptor.
Native settings используют upstreamVersion из metadata binary, не запускают новый
`-V`. Публичная upstream version не ограничивается pinned версией серверного checkout.
