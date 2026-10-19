package local.grigdesk.client.pipe;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import org.junit.Test;

public class ProtocolTest {
  /**
   * Разбор ограниченных заголовков не забирает байты следующего тела.
   * Неоднозначное framing отвергается до маршрутизации запроса.
   */
  @Test
  public void boundedHttpHeadKeepsBodyUnread() throws Exception {
    ByteArrayInputStream input = new ByteArrayInputStream(
      "POST /api/x HTTP/1.1\r\nHost: pipe\r\nContent-Length: 3\r\n\r\nabc"
        .getBytes(StandardCharsets.US_ASCII)
    );
    HttpHead head = HttpHead.read(input);

    assertNotNull(head);
    assertEquals("POST /api/x HTTP/1.1", head.first);
    assertEquals("3", head.headers.get("content-length"));
    assertEquals('a', input.read());
  }

  /**
   * Версия проверяется на каждом ответе и отсутствие заголовка означает отказ.
   * Успешный поздний ответ не снимает установленную несовместимость.
   */
  @Test
  public void apiVersionIsRequiredAndLatches() {
    assertEquals("client_upgrade_required", new VersionGate(0, 1).check("1.0", 200));
    assertEquals("server_upgrade_required", new VersionGate(0, 2).check("0.1", 200));
    assertEquals("server_upgrade_required", new VersionGate(0, 1).check(null, 200));
    assertNull(new VersionGate(0, 1).check(null, 101));
    assertNull(new VersionGate(0, 1).check("0.2", 200));

    VersionGate gate = new VersionGate(0, 1);

    assertEquals("client_upgrade_required", gate.check("1.0", 200));
    assertEquals("client_upgrade_required", gate.check("0.1", 200));
  }
}
