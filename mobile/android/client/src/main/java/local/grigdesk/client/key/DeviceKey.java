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
 * Обе версии личности используют Android Keystore с независимыми алиасами.
 * Потерянная старая привязка не получает автоматически новый ключ или software fallback.
 */
public final class DeviceKey {

  public static final String ALIAS = "grigdesk-client";
  public static final String ALIAS_V2 = "grigdesk-client-v2";

  private final String alias;

  public DeviceKey() {
    this(ALIAS);
  }

  /**
   * Отдельный алиас современной личности не трогает ключ прежних привязок.
   * Оба ключа живут в Keystore установки независимо друг от друга.
   */
  public DeviceKey(String alias) {
    this.alias = alias;
  }

  /** Имя алиаса нужно менеджеру ключа и диагностике без доступа к самому Keystore. */
  public String alias() {
    return alias;
  }

  private KeyStore store() throws Exception {
    KeyStore result = KeyStore.getInstance("AndroidKeyStore");

    result.load(null);

    return result;
  }

  public boolean exists() throws Exception {
    return store().containsAlias(alias);
  }

  /**
   * Современный ключ создаётся без аппаратного срока аутентификации.
   * Блокировкой управляет приложение, поэтому подпись TLS не требует prompt.
   */
  public void ensureWithoutAuthentication() throws Exception {
    if (exists()) {
      return;
    }

    KeyPairGenerator generator = KeyPairGenerator.getInstance(
      KeyProperties.KEY_ALGORITHM_EC,
      "AndroidKeyStore"
    );
    KeyGenParameterSpec options = new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
      .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_NONE, KeyProperties.DIGEST_SHA256)
      .setCertificateSubject(new X500Principal("CN=" + alias))
      .build();

    generator.initialize(options);
    generator.generateKeyPair();
  }

  public PrivateKey privateKey() throws Exception {
    PrivateKey result = (PrivateKey) store().getKey(alias, null);

    if (result == null) {
      throw new MissingDeviceKeyException();
    }

    return result;
  }

  public X509Certificate certificate() throws Exception {
    X509Certificate result = (X509Certificate) store().getCertificate(alias);

    if (result == null) {
      throw new MissingDeviceKeyException();
    }

    return result;
  }

  public void delete() throws Exception {
    store().deleteEntry(alias);
  }
}
