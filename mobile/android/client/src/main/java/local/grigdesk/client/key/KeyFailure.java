package local.grigdesk.client.key;

import java.security.cert.CertificateException;

public final class KeyFailure {
  private KeyFailure() {
  }

  /**
   * Conscrypt может поглотить InvalidKeyException при подписи TLS CertificateVerify.
   * Явный initSign до TLS сохраняет причину блокировки аппаратного ключа.
   */
  public static void check(javax.net.ssl.X509KeyManager keys) throws Exception {
    String[] aliases = keys.getClientAliases("EC", null);

    if (aliases == null || aliases.length == 0) {
      throw new MissingDeviceKeyException();
    }

    java.security.PrivateKey key = keys.getPrivateKey(aliases[0]);

    if (key == null) {
      throw new MissingDeviceKeyException();
    }

    java.security.Signature.getInstance("NONEwithECDSA").initSign(key);
  }

  /**
   * Keystore может спрятать причину в нескольких уровнях TLS-исключений.
   * Утрата ключа требует привязки, истечение аутентификации — разблокировки без нового ключа.
   */
  public static String status(Throwable exception) {
    String status = "offline";

    for (Throwable cause = exception; cause != null; cause = cause.getCause()) {
      String name = cause.getClass().getSimpleName();

      if (name.equals("UserNotAuthenticatedException")) {
        return "locked";
      }

      if (cause instanceof MissingDeviceKeyException || name.equals("KeyPermanentlyInvalidatedException")) {
        return "unpaired";
      }

      if (cause instanceof CertificateException) {
        status = "identityMismatch";
      }
    }

    return status;
  }
}
