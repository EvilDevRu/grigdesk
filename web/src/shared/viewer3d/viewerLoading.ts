// Lifecycle загрузки владеет поколением, abort, policy до публикации и временным lease.
// Опубликованная сцена, policy и её lease передаются одному владельцу engine.clear.
import { parseModel } from './modelParser.ts';
import type { ParsedModel } from './modelParser.ts';
import { disposeModel } from './modelDisposal.ts';
import { createResourcePolicy, fetchModelBytes } from './resourcePolicy.ts';
import type { ResourcePolicy } from './resourcePolicy.ts';
import type { ViewerLoadLease, ViewerModelLease } from './viewerBudget.ts';
import type { ViewerInfo, ViewerOptions } from './viewerEngine.ts';

interface ViewerLoadingPorts {
  isClosed(): boolean;
  isDisposed(): boolean;
  clearCurrent(): void;
  publish(parsed: ParsedModel, policy: ResourcePolicy, lease: ViewerModelLease): ViewerInfo;
  onProgress: ViewerOptions['onProgress'];
  budget: { createLease(): ViewerLoadLease };
}

/**
 * Отмена контекста не меняет поколение; dispose отдельно инвалидирует его перед abort.
 * Clear и публикация вызываются в прежних точках относительно сети и parser.
 */
export function createViewerLoading(ports: ViewerLoadingPorts) {
  let generation = 0;
  let controller: AbortController | null = null;

  /**
   * Src имеет собственное поколение и AbortController, ресурсы старого parser не публикуются.
   * Две сравниваемые сцены получают общий memory lease до добавления в WebGL scene.
   */
  async function load(url: string, ext: string): Promise<ViewerInfo> {
    if (ports.isClosed()) {
      throw new Error('Просмотрщик закрыт или WebGL недоступен.');
    }
    
    const current = ++generation;
    
    controller?.abort();
    ports.clearCurrent();
    
    const own = new AbortController();
    
    controller = own;
    
    const resources = createResourcePolicy(url);
    let parsed: ParsedModel | null = null;
    let published = false;
    const lease = ports.budget.createLease();
    const reserve = lease.reserve;

    try {
      const bytes = await fetchModelBytes(resources.source, own.signal, undefined, (loaded, total) => {
        reserve(loaded * 2);

        if (!ports.isDisposed() && current === generation) {
          ports.onProgress?.(loaded, total);
        }
      });
      
      parsed = await parseModel(bytes, ext, {
        policy: resources,
        signal: own.signal,
        reserve
      });
      
      if (ports.isDisposed() || current !== generation || own.signal.aborted) {
        throw new Error('Загрузка модели отменена.');
      }

      const modelLease = lease.publish(parsed.memory);

      published = true;

      return ports.publish(parsed, resources, modelLease);
    } catch (cause) {
      if (current === generation && published) {
        ports.clearCurrent();
      }
      else if (parsed) {
        disposeModel(parsed.scene);
      }
      
      resources.dispose();
      
      throw cause;
    } finally {
      lease.release();
    }
  }

  return {
    load,
    abort() {
      controller?.abort();
    },
    invalidate() {
      generation += 1;
      controller?.abort();
    }
  };
}
