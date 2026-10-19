package local.grigdesk.client.key;

import java.net.Socket;
import java.security.Principal;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.X509ExtendedKeyManager;

/**
 * Client certificate предлагается уже в первом handshake для pair.
 * Экспортируемый ключ не создаётся даже при отказе аппаратного Keystore.
 */
public final class DeviceKeyManager extends X509ExtendedKeyManager {

  private final DeviceKey key;

  public DeviceKeyManager(DeviceKey key) {
    this.key = key;
  }

  @Override
  public String chooseClientAlias(String[] types, Principal[] issuers, Socket socket) {
    return DeviceKey.ALIAS;
  }

  @Override
  public String chooseEngineClientAlias(String[] types, Principal[] issuers, SSLEngine engine) {
    return DeviceKey.ALIAS;
  }

  @Override
  public String[] getClientAliases(String type, Principal[] issuers) {
    return new String[] { DeviceKey.ALIAS };
  }

  @Override
  public PrivateKey getPrivateKey(String alias) {
    try {
      return DeviceKey.ALIAS.equals(alias) ? key.privateKey() : null;
    } catch (Exception exception) {
      throw new IllegalStateException("Ключ устройства недоступен", exception);
    }
  }

  @Override
  public X509Certificate[] getCertificateChain(String alias) {
    try {
      return DeviceKey.ALIAS.equals(alias) ? new X509Certificate[] { key.certificate() } : null;
    } catch (Exception exception) {
      throw new IllegalStateException("Сертификат устройства недоступен", exception);
    }
  }

  @Override
  public String chooseServerAlias(String type, Principal[] issuers, Socket socket) {
    return null;
  }

  @Override
  public String[] getServerAliases(String type, Principal[] issuers) {
    return null;
  }
}
