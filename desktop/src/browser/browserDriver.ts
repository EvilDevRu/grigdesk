interface BrowserInput {
  action: 'click' | 'fill' | 'scroll';
  ref?: string;
  pageEpoch: number;
  text?: string;
  deltaY?: number;
}

/**
 * Проверка доступа повторяется перед каждым отдельным эффектом CDP.
 * Между получением координат и вводом навигация или отзыв не сохраняют старое разрешение.
 */
export function createBrowserDriver(port: {
  allowed(): boolean;
  epoch(): number;
  resolve(ref: string): Promise<{
    x: number;
    y: number;
    editable: boolean
  } | null>;
  send(name: string, value: unknown): Promise<unknown>;
  act(payload: { action: 'click' | 'fill' | 'scroll'; ref: string; text?: string; deltaY?: number }): Promise<{
    ok: boolean
  }>;
}) {
  return {
    /**
     * Системный ввод работает с видимым элементом текущего snapshot.
     * Строка текста идёт аргументом протокола и не исполняется как JavaScript.
     */
    async input(input: BrowserInput) {
      /**
       * Каждый эффект использует актуальное разрешение и эпоху наблюдения.
       * Отзыв или навигация между ожиданиями останавливают оставшийся ввод.
       */
      const check = () => {
        if (!port.allowed()) {
          throw new Error('access_revoked');
        }

        if (input.pageEpoch !== port.epoch()) {
          throw new Error('stale_page');
        }
      };
      const send = async (name: string, value: unknown) => {
        check();
        await port.send(name, value);
      };

      check();

      if (input.action === 'scroll') {
        const deltaY = Math.max(-2000, Math.min(2000, input.deltaY ?? 0));

        await send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: 50,
          y: 50,
          deltaX: 0,
          deltaY,
        });

        return;
      }

      const target = await port.resolve(input.ref ?? '');

      if (!target) {
        throw new Error('stale_element');
      }

      if (input.action === 'fill' && (!target.editable || (input.text?.length ?? 0) > 10000)) {
        throw new Error('invalid_fill');
      }

      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', {
          type,
          x: target.x,
          y: target.y,
          button: 'left',
          clickCount: 1,
        });
      }

      if (input.action === 'fill') {
        await send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'a',
          code: 'KeyA',
          modifiers: 2
        });
        await send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'a',
          code: 'KeyA',
          modifiers: 2
        });
        await send('Input.insertText', { text: input.text ?? '' });
      }
    },
    /**
     * DOM-исполнение команды для вкладки вне экрана: действие выполняется
     * в изолированном мире страницы и не зависит от видимости native view.
     * Проверки доступа и эпохи повторяются вокруг единственного эффекта.
     */
    async domInput(input: BrowserInput) {
      if (!port.allowed()) {
        throw new Error('access_revoked');
      }

      if (input.pageEpoch !== port.epoch()) {
        throw new Error('stale_page');
      }

      await port.act({
        action: input.action,
        ref: input.ref ?? '',
        text: input.text,
        deltaY: input.deltaY
      });
    },
  };
}
