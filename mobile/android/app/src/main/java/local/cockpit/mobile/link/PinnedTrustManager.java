package local.cockpit.mobile.link;

import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import javax.net.ssl.X509TrustManager;

public final class PinnedTrustManager implements X509TrustManager {

  private final String pin;

  public PinnedTrustManager(String pin) {
    QrPayload.fingerprint(pin);
    this.pin = pin;
  }

  /**
   * Сервер принимается только по точному пину первого сертификата цепочки.
   * TLS CertificateVerify доказывает владение ключом без проверки CA/self-signature.
   */
  @Override
  public void checkServerTrusted(X509Certificate[] chain, String authType)
    throws CertificateException {
    try {
      if (chain == null || chain.length == 0 || !Pins.matches(chain[0], pin)) {
        throw new CertificateException("Пин сервера не совпадает");
      }
    } catch (CertificateException exception) {
      throw exception;
    } catch (Exception exception) {
      throw new CertificateException("Пин сервера не совпадает", exception);
    }
  }

  @Override
  public void checkClientTrusted(X509Certificate[] chain, String authType)
    throws CertificateException {
    throw new CertificateException("Клиентская цепочка не поддерживается");
  }

  @Override
  public X509Certificate[] getAcceptedIssuers() {
    return new X509Certificate[0];
  }
}
