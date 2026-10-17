// Анимация модели владеет mixer/action и скоростью, не создавая собственного RAF.
// Engine передаёт кадр и callback немедленного рендера после seek.
import * as THREE from 'three';
import type { ParsedModel } from './modelParser.ts';

/**
 * Сохраняет позу на паузе и освобождает mixer до удаления модели из сцены.
 * Clock и частота публикации времени остаются у единственного render loop движка.
 */
export function createViewerAnimation(render: () => void) {
  let model: ParsedModel | null = null;
  let mixer: THREE.AnimationMixer | null = null;
  let action: THREE.AnimationAction | null = null;
  let speed = 1;

  /**
   * Mixer создаётся в прежней точке публикации новой модели.
   * Клипы остаются частью ParsedModel, их список не пересобирается.
   */
  function setModel(parsed: ParsedModel): void {
    model = parsed;
    mixer = new THREE.AnimationMixer(model.scene);
  }

  /**
   * Единственный кадр engine продвигает активный клип на прежний delta со скоростью.
   * На паузе поза и время сохраняются без дополнительного рендера.
   */
  function advance(delta: number): void {
    if (mixer && action && !action.paused) {
      mixer.update(delta * speed);
    }
  }

  /**
   * Stop и uncache выполняются до удаления сцены и освобождения её ресурсов.
   * Повторное освобождение не затрагивает следующую модель.
   */
  function dispose(): void {
    if (mixer && model) {
      mixer.stopAllAction();
      mixer.uncacheRoot(model.scene);
    }
    
    mixer = null;
    action = null;
    
    model = null;
  }

  return {
    setModel,
    advance,
    dispose,
    currentTime: () => action?.time || 0,
    /**
     * Клип управляет настоящей позой через AnimationMixer.
     * Пауза сохраняет время, выбор другого клипа начинает его с нуля.
     */
    playClip(name: string | null) {
      if (!model || !mixer) {
        return;
      }
      if (!name) { if (action) {
        action.paused = true;
      } 
      
      return; }
      
      const clip = model.clips.find((item) => item.name === name);
      
      if (!clip) {
        return;
      }
      if (action?.getClip() !== clip) {
        mixer.stopAllAction();
        action = mixer.clipAction(clip);
        action.reset();
      }
      
      action.paused = false;
      action.play();
    },
    /**
     * Переход ограничен длительностью клипа и сразу обновляет кадр.
     * Исходный признак паузы сохраняется после вычисления новой позы.
     */
    setTime(seconds: number) {
      if (!mixer || !action || !Number.isFinite(seconds)) {
        return;
      }
      
      const paused = action.paused;
      
      action.paused = false;
      mixer.setTime(Math.max(0, Math.min(action.getClip().duration, seconds)));
      action.paused = paused;
      render();
    },
    setSpeed(value: number) {
      speed = Math.max(0.5, Math.min(2, Number.isFinite(value) ? value : 1));
    },
  };
}
