package local.grigdesk.client;

import android.content.Context;
import android.content.res.AssetManager;
import android.graphics.Color;
import android.net.Uri;
import android.text.TextUtils;
import android.util.Log;
import android.view.Gravity;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import local.grigdesk.client.pipe.StaticAssets;
import local.grigdesk.client.shell.ShellLocale;

final class ProbeSplashView extends FrameLayout {
    private static final String HOST = "grigdesk-splash.invalid";
    private static final String ASSETS = "desktop-splash";
    private static final int BACKGROUND = Color.rgb(21, 25, 31);
    private static final int MAX_WIDTH_DP = 540;
    private static final int WINDOW_MARGIN_DP = 32;

    private final WebView page;

    /**
     * Окно повторяет холст и ресурсы desktop, сохраняя поля на телефоне.
     * Отдельный WebView читает только встроенные файлы и живёт до начала работы основного окна.
     */
    ProbeSplashView(Context context) {
        super(context);
        setBackgroundColor(BACKGROUND);
        setClickable(true);
        setFocusable(true);

        page = new WebView(context);
        page.setBackgroundColor(BACKGROUND);
        page.getSettings().setAllowFileAccess(false);
        page.getSettings().setAllowContentAccess(false);
        page.getSettings().setUseWideViewPort(true);
        page.setVerticalScrollBarEnabled(false);
        page.setHorizontalScrollBarEnabled(false);
        page.setWebViewClient(new SplashAssets(context));

        float density = getResources().getDisplayMetrics().density;
        int availableWidth = getResources().getConfiguration().screenWidthDp - WINDOW_MARGIN_DP;
        int availableHeight = getResources().getConfiguration().screenHeightDp - WINDOW_MARGIN_DP;
        float widthDp = Math.min(MAX_WIDTH_DP, Math.min(availableWidth, availableHeight * 1.5f));
        int unit = Math.max(1, (int) (widthDp * density / 3));

        addView(page, new LayoutParams(unit * 3, unit * 2, Gravity.CENTER));
        page.loadUrl("https://" + HOST + "/index.html");
    }

    void close() {
        removeView(page);
        page.destroy();
    }

    private static final class SplashAssets extends WebViewClient {
        private final AssetManager assets;
        private final String locale;
        private final String status;

        /**
         * Локаль и статус фиксируются при создании окна и подставляются как текст.
         * Русская версия самой заставки остаётся запасной при отказе каталога локали.
         */
        SplashAssets(Context context) {
            assets = context.getAssets();

            ShellLocale language = null;

            try {
                language = ClientLocale.initialize(context);
            } catch (Exception error) {
                Log.w("GrigDeskProbe", "Не удалось прочитать локаль заставки", error);
            }

            locale = language == null ? "ru" : language.locale();
            status = ShellLocale.text(language, "desktop.startingServer", "Запуск сервера…");
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return true;
        }

        /**
         * Запросы ограничены адресом заставки и тремя связанными ресурсами.
         * Остальные получают локальный отказ без сетевого или файлового доступа.
         */
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();

            if ("GET".equals(request.getMethod()) && "https".equals(url.getScheme())
                && HOST.equals(url.getEncodedAuthority()) && url.getQuery() == null) {
                try {
                    return switch (url.getEncodedPath()) {
                        case "/index.html" -> document();
                        case "/style.css" -> asset("style.css", "text/css", "UTF-8");
                        case "/background.png" -> asset("background.png", "image/png", null);
                        case "/wordmark.svg" -> asset("wordmark.svg", "image/svg+xml", "UTF-8");
                        default -> missing();
                    };
                } catch (IOException error) {
                    Log.w("GrigDeskProbe", "Не удалось открыть ресурс заставки", error);
                }
            }

            return missing();
        }

        /**
         * Разметка принадлежит desktop. Телефон добавляет размер viewport и переводит
         * исходную подпись, сохраняя CSP, фон, фирменную надпись и анимации.
         */
        private WebResourceResponse document() throws IOException {
            String html = StaticAssets.readText(assets.open(ASSETS + "/index.html"), 8192);
            String viewport = "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">";
            String localized = html.replace("lang=\"ru\"", "lang=\"" + TextUtils.htmlEncode(locale) + "\"")
                .replace("<meta charset=\"utf-8\">", "<meta charset=\"utf-8\">\n  " + viewport)
                .replace("<p class=\"status\">Загрузка…</p>",
                    "<p class=\"status\">" + TextUtils.htmlEncode(status) + "</p>");

            return new WebResourceResponse("text/html", "UTF-8",
                new ByteArrayInputStream(localized.getBytes(StandardCharsets.UTF_8)));
        }

        private WebResourceResponse asset(String name, String mime, String encoding) throws IOException {
            return new WebResourceResponse(mime, encoding, assets.open(ASSETS + "/" + name));
        }

        private static WebResourceResponse missing() {
            return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", Map.of(),
                new ByteArrayInputStream(new byte[0]));
        }
    }
}
