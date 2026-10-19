package local.grigdesk.client;

import com.journeyapps.barcodescanner.CaptureActivity;

/**
 * Сканер принадлежит тому же приложению и участвует в его счётчике Activity.
 * Камера ограничена экраном сканирования и не выдаётся содержимому WebView.
 */
public final class ScannerActivity extends CaptureActivity {
}
