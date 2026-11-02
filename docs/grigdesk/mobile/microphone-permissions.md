# Разрешения микрофона полного Android-клиента

Manifest модуля `:client` объявляет `RECORD_AUDIO` и `MODIFY_AUDIO_SETTINGS`.
Chromium проверяет оба разрешения перед выбором коммуникационного аудиоустройства;
при отсутствии одного отказывается предоставлять устройство записи. Контракт виден
в [AudioManagerAndroid](https://chromium.googlesource.com/chromium/src/media/+/master/base/android/java/src/org/chromium/media/AudioManagerAndroid.java),
в методах `setCommunicationDevice` и `getCommunicationDevices`.

`MODIFY_AUDIO_SETTINGS` — обычное manifest-разрешение. Системный запрос записи
`RECORD_AUDIO` и политика `WebPolicy.microphone` сохраняются: WebView получает только
`RESOURCE_AUDIO_CAPTURE` для origin открытой локальной трубы. Разрешение не открывает
камеру, произвольные origin или фоновую запись.

Сообщение `Could not start audio source` возникает до начала распознавания и само по
себе не доказывает единственную причину: возможны также занятый микрофон и ограничения
устройства. Проверка manifest и `aapt2 dump permissions` подтверждает наличие разрешений
в готовом APK; фактическое получение звука проверяется отдельно на физическом Android.

Изменение manifest требует пересборки и установки APK. Обновления web-ресурсов недостаточно;
при сохранении сертификата пакет обновляется поверх установленного приложения.
