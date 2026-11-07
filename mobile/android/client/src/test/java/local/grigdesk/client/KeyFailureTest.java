package local.grigdesk.client;

import static org.junit.Assert.*;
import java.io.IOException;
import java.security.cert.CertificateException;
import local.grigdesk.client.key.KeyFailure;
import local.grigdesk.client.key.MissingDeviceKeyException;
import org.junit.Test;

public class KeyFailureTest {
  private static class UserNotAuthenticatedException extends Exception {
  }

  /**
   * Вложенные TLS-исключения сохраняют причину отказа нативного ключа.
   * Сетевой отказ остаётся повторяемым offline, а ключ и pin требуют действия.
   */
  @Test
  public void nestedNativeFailureKeepsItsMeaning() {
    assertEquals("locked", KeyFailure.status(new IOException("TLS",
      new IllegalStateException(new UserNotAuthenticatedException()))));
    assertEquals("unpaired", KeyFailure.status(new IOException("TLS", new MissingDeviceKeyException())));
    assertEquals("identityMismatch", KeyFailure.status(new IOException("TLS", new CertificateException())));
    assertEquals("offline", KeyFailure.status(new IOException("Сеть недоступна")));
  }
}
