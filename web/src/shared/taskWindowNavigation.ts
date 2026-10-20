interface PipelineNavigation {
  document: boolean;
  send(): Promise<unknown>;
  route(): Promise<unknown>;
  close(): void;
  failure(): void;
}
/**
 * Карточка закрывается лишь после принятого перехода, чтобы отказ не уничтожал контекст.
 * Inline-представление использует свой router и не обращается к нативной оболочке.
 */
export async function leaveTaskForPipeline(options: PipelineNavigation): Promise<void> {
  try {
    if (options.document) {
      const result = await options.send();

      if (!result || typeof result !== 'object' || !('opened' in result) || result.opened !== true) {
        options.failure();

        return;
      }
    }
    else {
      options.close();
      await options.route();

      return;
    }

    options.close();
  }
  catch {
    options.failure();
  }
}
