package local.grigdesk.client;

import java.net.URI;
import java.util.Set;

public final class WebPolicy {
  private final Set<String> origins;

  public WebPolicy(Set<String> origins) {
    this.origins = origins;
  }

  /**
   * Доверие задаётся набором реально открытых труб, а не любым loopback-портом.
   * Userinfo, непрямые схемы и похожие имена хоста не получают полномочий приложения.
   */
  public boolean navigation(String text) {
    try {
      URI uri = new URI(text);
      String origin = uri.getScheme() + "://" + uri.getHost() + ":" + uri.getPort();

      return "http".equals(uri.getScheme()) && "127.0.0.1".equals(uri.getHost())
        && uri.getUserInfo() == null && origins.contains(origin);
    } catch (Exception exception) {
      return false;
    }
  }

  /**
   * Микрофон принадлежит только origin открытой трубы и единственному audio-ресурсу.
   * Смешанный запрос камеры и звука не расширяет выданное разрешение.
   */
  public boolean microphone(String url, String[] resources) {
    return navigation(url) && resources.length == 1
      && "android.webkit.resource.AUDIO_CAPTURE".equals(resources[0]);
  }

  /**
   * Только обычная HTTP(S)-ссылка может открыться системным браузером.
   * Жест, метод и основной фрейм дополнительно проверяются вызывающей Activity.
   */
  public boolean external(String text) {
    try {
      URI uri = new URI(text);

      return ("http".equals(uri.getScheme()) || "https".equals(uri.getScheme()))
        && uri.getHost() != null && uri.getUserInfo() == null;
    } catch (Exception exception) {
      return false;
    }
  }
}
