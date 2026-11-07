# Установка PWA снята

GrigDesk открывается в [локальном приложении](desktop-window.md). Bootstrap не регистрирует
service worker и не подписывается на предложение браузерной установки. Сборка не выпускает
manifest или Workbox; зависимости vite-plugin-pwa и notification-sw.js удалены.

Иконки `web/public/icon-{96,192,512}.png` и maskable сохраняются для приложения и ярлыка.
Системное уведомление получает PNG data URL, встроенный в сборку: загрузчику ОС не нужна
cookie защищённой статики. Уведомления идут через Notification API окна.
Старую PWA удаляет человек в браузере. Её прежняя сессия отозвана при миграции.

[Обновление окна](service-worker-cache-refresh.md), [знак GrigDesk](brand-mark.md).
