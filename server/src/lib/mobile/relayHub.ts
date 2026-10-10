import { RelayLink } from './relayLink.ts';
import type { Relay } from './store.ts';

export class RelayHub {
  private links = new Map<string, RelayLink>();
  private options: {
    mobilePort: number;
    vpnGate: (ip: string) => Promise<boolean>;
    changed?: () => void;
  };

  constructor(options: {
    mobilePort: number;
    vpnGate: (ip: string) => Promise<boolean>;
    changed?: () => void;
  }) {
    this.options = options;
  }

  /**
   * Согласует подключения с проверенным снимком настроек.
   * Удаление или смена адреса сначала закрывает старое поколение и все его пары.
   */
  sync(relays: Relay[]) {
    for (const [id, link] of this.links) {
      const current = relays.find((relay) => relay.id === id && relay.enabled);

      if (!current || JSON.stringify(current) !== JSON.stringify(link.relay)) {
        link.stop();
        this.links.delete(id);
      }
    }

    for (const relay of relays.filter((item) => item.enabled)) {
      if (!this.links.has(relay.id)) {
        const link = new RelayLink({
          ...this.options,
          relay,
        });

        this.links.set(relay.id, link);
        link.start();
      }
    }
  }

  status() {
    return [...this.links.values()].map((link) => link.status());
  }

  close() {
    for (const link of this.links.values()) {
      link.stop();
    }

    this.links.clear();
  }
}
