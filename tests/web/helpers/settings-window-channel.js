/**
 * Хаб доставляет сообщения только другим открытым портам с тем же именем.
 * Подмена не создаёт канал Node и позволяет проверить закрытие каждого порта.
 */
export function channelHub() {
  const ports = [];
  const factory = (name) => {
    const port = {
      name,
      onmessage: null,
      closed: 0,
      sent: [],
      /**
       * Доставка асинхронна и исключает порт отправителя.
       * Закрытые получатели не вызываются даже при уже запланированном сообщении.
       */
      postMessage(message) {
        port.sent.push(message);

        for (const peer of ports) {
          if (peer !== port && peer.name === name && !peer.closed) {
            queueMicrotask(() => {
              if (!peer.closed) {
                peer.onmessage?.({ data: message });
              }
            });
          }
        }
      },
      close() {
        port.closed += 1;
      },
    };

    ports.push(port);

    return port;
  };

  return { factory, ports };
}

/**
 * Ожидает доставку очереди подменного канала и ответных сообщений.
 * Таймер продукта при этом остаётся настоящим и ограничивает намерение.
 */
export async function flushChannel() {
  await new Promise((resolve) => setImmediate(resolve));
}
