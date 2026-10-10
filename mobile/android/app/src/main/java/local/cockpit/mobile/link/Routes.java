package local.cockpit.mobile.link;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/**
 * Плагин принимает только JSON методы мобильного фасада и не выступает произвольным proxy.
 * Pair, SSE, media и APK принадлежат специализированным native вызовам.
 */
public final class Routes {

  private Routes() {
  }

  /**
   * Path не содержит внешнего origin, traversal, encoded slash или повторной декодировки.
   * Query разрешает только известные имена и не добавляет произвольных заголовков.
   */
  public static boolean allowed(String method, String path) {
    if (
      path == null ||
      path.length() > 4096 ||
      !path.startsWith("/api/mobile/v1/") ||
      path.matches(".*[\\\\#\\x00-\\x20].*") ||
      !("GET".equals(method) || "POST".equals(method))
    ) {
      return false;
    }

    try {
      URI uri = new URI(path);
      String route = uri.getRawPath().substring("/api/mobile/v1/".length());

      if (
        route.contains("%") || route.contains("..") || route.contains("//") || uri.getHost() != null
      ) {
        return false;
      }
      if ("POST".equals(method)) {
        return (
          uri.getRawQuery() == null &&
          route.matches(
            "(" +
              "chats|chats/[A-Za-z0-9_-]{1,64}/(messages|stop|settings|read|workspace(/preview)?)|" +
              "waiting/[A-Za-z0-9_-]{1,200}|" +
              "tasks/[0-9]+/(gate|resume|stop)|b24/tasks/[0-9]+/launch)"
          )
        );
      }

      boolean valid =
        route.matches("(hello|chats|chat-options|attention|waiting|tasks|b24/tasks|app)") ||
        route.matches(
          "(" +
            "chats/[A-Za-z0-9_-]{1,64}(/deliveries)?|waiting/[A-Za-z0-9_-]{1,200}/details|" +
            "tasks/[0-9]+(/plan)?|b24/tasks/[0-9]+(/launch-options)?|operations/[A-Za-z0-9_-]{8,80})"
        );

      if (!valid) {
        return false;
      }
      if (uri.getRawQuery() != null) {
        for (String field : uri.getRawQuery().split("&")) {
          String key = URLDecoder.decode(field.split("=", 2)[0], "UTF-8");

          if (
            !Arrays.asList(
              "cursor",
              "before",
              "revision",
              "limit",
              "offset",
              "contentRevision",
              "ids"
            ).contains(key)
          ) {
            return false;
          }
        }
      }

      return true;
    } catch (Exception exception) {
      return false;
    }
  }
}
