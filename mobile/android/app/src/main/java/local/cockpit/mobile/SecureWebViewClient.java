package local.cockpit.mobile;

import android.net.Uri;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.widget.Toast;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.util.Collections;

/**
 * WebView читает bundled assets и только собственные проверенные media текущего unlock.
 * Любая внешняя навигация, HTTP API и произвольный file/content URL закрыты до сети.
 */
final class SecureWebViewClient extends BridgeWebViewClient {

  private final CockpitLinkPlugin link;

  SecureWebViewClient(Bridge bridge, CockpitLinkPlugin link) {
    super(bridge);
    this.link = link;
  }

  @Override
  public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
    Uri uri = request.getUrl();

    if (
      request.isForMainFrame() && request.hasGesture() && "GET".equals(request.getMethod()) &&
      ("https".equals(uri.getScheme()) || "http".equals(uri.getScheme())) && !isLocal(uri)
    ) {
      // Только явное нажатие ссылки передаётся системному браузеру.
      // Внешний документ никогда не получает WebView с мостом устройства.
      try {
        view.getContext().startActivity(new Intent(Intent.ACTION_VIEW, uri));
      } catch (ActivityNotFoundException unavailable) {
        Toast.makeText(view.getContext(), "На устройстве нет браузера", Toast.LENGTH_SHORT).show();
      }

      return true;
    }

    return !isAsset(request.getUrl()) || !"GET".equals(request.getMethod());
  }

  /**
   * WebView читает только собственные assets и разрешённые файлы текущей unlock-сессии.
   * Произвольные внешние адреса и файловые схемы не получают нативный сетевой доступ.
   */
  @Override
  public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
    Uri uri = request.getUrl();

    if (!"GET".equals(request.getMethod()) || !isLocal(uri)) {
      return denied();
    }

    String path = uri.getPath();

    if (path.startsWith("/_capacitor_file_/")) {
      return media(path.substring("/_capacitor_file_".length()));
    }
    if (!isAsset(uri)) {
      return denied();
    }

    return super.shouldInterceptRequest(view, request);
  }

  private static boolean isLocal(Uri uri) {
    return (
      "https".equals(uri.getScheme()) &&
      "localhost".equals(uri.getHost()) &&
      uri.getPort() == -1 &&
      uri.getUserInfo() == null
    );
  }

  private static boolean isAsset(Uri uri) {
    if (!isLocal(uri) || uri.getEncodedQuery() != null) {
      return false;
    }

    String path = uri.getPath();

    return (
      path != null &&
      (path.equals("/") ||
        path.equals("/index.html") ||
        path.matches("/assets/[A-Za-z0-9_.-]+") ||
        path.matches("/icon-[A-Za-z0-9_-]+[.]png") ||
        path.equals("/capacitor.js") ||
        path.equals("/cordova.js"))
    );
  }

  /**
   * File URI не проходит общий Capacitor filesystem server, даже при известном абсолютном пути.
   * Canonical имя и каталог проверяются до открытия; lock очищает файлы и отзывает этот gate.
   */
  private WebResourceResponse media(String requested) {
    try {
      if (!link.canReadMedia()) {
        return denied();
      }

      File file = new File(requested).getCanonicalFile();
      File directory = link.mediaDirectory().getCanonicalFile();

      if (
        !file.getName().matches("[a-f0-9]{64}") ||
        !directory.equals(file.getParentFile()) ||
        !file.isFile() ||
        java.nio.file.Files.isSymbolicLink(new File(requested).toPath())
      ) {
        return denied();
      }

      String type;
      byte[] header = new byte[12];

      try (FileInputStream input = new FileInputStream(file)) {
        if (input.read(header) < 12) {
          return denied();
        }
      }

      if ((header[0] & 255) == 137) {
        type = "image/png";
      } else if ((header[0] & 255) == 255) {
        type = "image/jpeg";
      } else if (header[0] == 'G') {
        type = "image/gif";
      } else {
        type = "image/webp";
      }
      if (!link.canReadMedia()) {
        return denied();
      }

      return new WebResourceResponse(
        type,
        null,
        200,
        "OK",
        Collections.singletonMap("Cache-Control", "no-store"),
        link.openMedia(file)
      );
    } catch (Exception exception) {
      return denied();
    }
  }

  private static WebResourceResponse denied() {
    return new WebResourceResponse(
      "text/plain",
      "UTF-8",
      403,
      "Forbidden",
      Collections.singletonMap("Cache-Control", "no-store"),
      new ByteArrayInputStream(new byte[0])
    );
  }
}
