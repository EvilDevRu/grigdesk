package local.cockpit.mobile.link;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;

public final class Pins {

  private Pins() {
  }

  /**
   * Пин относится к DER сертификату целиком, как fingerprint256 Node/OpenSSL.
   * Системные CA и подпись самоподписанного сертификата не участвуют в допуске.
   */
  public static String sha256Hex(byte[] der) {
    try {
      byte[] hash = MessageDigest.getInstance("SHA-256").digest(der);
      StringBuilder result = new StringBuilder(64);

      for (byte value : hash) {
        result.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
      }

      return result.toString();
    } catch (Exception exception) {
      throw new IllegalStateException("SHA256 недоступен", exception);
    }
  }

  public static boolean matches(X509Certificate certificate, String pin) throws Exception {
    QrPayload.fingerprint(pin);

    return MessageDigest.isEqual(
      sha256Hex(certificate.getEncoded()).getBytes(StandardCharsets.US_ASCII),
      pin.getBytes(StandardCharsets.US_ASCII)
    );
  }
}
