package local.grigdesk.mobile;

import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

/**
 * Release WebView исполняет только bundled интерфейс с собственным нативным мостом.
 * JS не получает удалённый HTTP transport, доступ к filesystem или отладочный WebView endpoint.
 */
public class MainActivity extends BridgeActivity {

  /**
   * Плагин регистрируется до создания Capacitor bridge и загрузки WebView.
   * Локальный перехватчик ограничивает доступ, а системный шрифт масштабируется один раз.
   */
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(GrigDeskLinkPlugin.class);
    super.onCreate(savedInstanceState);

    GrigDeskLinkPlugin link = (GrigDeskLinkPlugin) getBridge().getPlugin("GrigDeskLink").getInstance();
    WebView view = getBridge().getWebView();
    WebSettings settings = view.getSettings();

    getBridge().setWebViewClient(new SecureWebViewClient(getBridge(), link));
    settings.setTextZoom(100);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    settings.setSupportMultipleWindows(false);
    WebView.setWebContentsDebuggingEnabled(
      (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0
    );
  }
}
