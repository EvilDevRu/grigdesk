package local.grigdesk.client.key;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;
import java.security.spec.ECGenParameterSpec;
import javax.security.auth.x500.X500Principal;

/**
 * Личный ключ создаётся исключительно в Android Keystore с обязательной аутентификацией.
 * Потерянная старая привязка не получает автоматически новый ключ или software fallback.
 */
public final class DeviceKey {

  public static final String ALIAS = "grigdesk-client";

  private KeyStore store() throws Exception {
    KeyStore result = KeyStore.getInstance("AndroidKeyStore");

    result.load(null);

    return result;
  }

  public boolean exists() throws Exception {
    return store().containsAlias(ALIAS);
  }

  /**
   * SIGN/NONE/SHA256 позволяют Android подписать TLS CertificateVerify для P-256.
   * Окно аутентификации ограничено 600 секундами и допускает сильную биометрию или код.
   */
  public void ensure() throws Exception {
    if (exists()) {
      return;
    }

    KeyPairGenerator generator = KeyPairGenerator.getInstance(
      KeyProperties.KEY_ALGORITHM_EC,
      "AndroidKeyStore"
    );
    KeyGenParameterSpec options = new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
      .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_NONE, KeyProperties.DIGEST_SHA256)
      .setUserAuthenticationRequired(true)
      .setUserAuthenticationParameters(
        600,
        KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL
      )
      .setCertificateSubject(new X500Principal("CN=grigdesk-client"))
      .build();

    generator.initialize(options);
    generator.generateKeyPair();
  }

  public PrivateKey privateKey() throws Exception {
    PrivateKey result = (PrivateKey) store().getKey(ALIAS, null);

    if (result == null) {
      throw new MissingDeviceKeyException();
    }

    return result;
  }

  public X509Certificate certificate() throws Exception {
    X509Certificate result = (X509Certificate) store().getCertificate(ALIAS);

    if (result == null) {
      throw new MissingDeviceKeyException();
    }

    return result;
  }

  public void delete() throws Exception {
    store().deleteEntry(ALIAS);
  }
}
