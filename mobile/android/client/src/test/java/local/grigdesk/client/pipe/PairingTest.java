package local.grigdesk.client.pipe;

import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import local.grigdesk.client.shell.Pairing;
import local.grigdesk.client.shell.ProfileStore;
import org.json.JSONObject;
import org.junit.Test;

public class PairingTest {
  /**
   * Bootstrap hello не знает имя машины даже после успешного pair на том же сокете.
   * Имя берётся из pin-проверенного ответа pair, а не из общей заставки GrigDesk.
   */
  @Test
  public void machineNameComesFromPairResponse() throws Exception {
    Path root = Files.createTempDirectory("grigdesk-pair-name-");
    Path file = root.resolve("profiles.json");
    final String[] pin = new String[1];

    try (TlsFixture server = new TlsFixture((head, body, output) -> {
      while (body.read() != -1) {
        // Тело pair потребляется до формирования управляющего ответа.
      }
      JSONObject response = new JSONObject();
      if (head.target().endsWith("/pair")) {
        response.put("server", new JSONObject().put("name", "Рабочая машина").put("fp", pin[0]));
      } else {
        response.put("name", "GrigDesk").put("fp", pin[0]);
      }
      TlsFixture.response(output, 200, "0.1", response.toString().getBytes(StandardCharsets.UTF_8));
    })) {
      pin[0] = server.pin;
      Pairing pairing = new Pairing(new ProfileStore(file.toFile(), port -> true),
        () -> TlsFixture.keys("client"), 0, 1);
      assertEquals("Рабочая машина", pairing.add(payload(server)).getString("name"));
    } finally {
      Files.deleteIfExists(file);
      Files.deleteIfExists(root);
    }
  }

  /**
   * Несовместимость API объясняет человеку, какую сторону нужно обновить.
   * Текст ошибки не содержит адреса или сырого кода протокола.
   */
  @Test
  public void versionFailureHasSpecificRussianMessage() throws Exception {
    Path root = Files.createTempDirectory("grigdesk-pair-version-");
    Path file = root.resolve("profiles.json");

    try (TlsFixture server = new TlsFixture((head, body, output) -> {
      TlsFixture.response(output, 200, "0.0", "{}".getBytes(StandardCharsets.UTF_8));
    })) {
      Pairing pairing = new Pairing(new ProfileStore(file.toFile(), port -> true),
        () -> TlsFixture.keys("client"), 0, 1);
      Exception error = assertThrows(Exception.class, () -> pairing.add(payload(server)));

      assertEquals("Обновите GrigDesk на машине.", error.getMessage());
    } finally {
      Files.deleteIfExists(file);
      Files.deleteIfExists(root);
    }
  }

  /**
   * Конверт содержит только синтетические адрес и pin TLS-стенда.
   * Биты кодируются без padding по общему формату привязки.
   */
  private static String payload(TlsFixture server) throws Exception {
    java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
    output.write(new byte[] {4, 127, 0, 0, 1});
    output.write(server.server.getLocalPort() >> 8);
    output.write(server.server.getLocalPort() & 255);
    for (int index = 0; index < server.pin.length(); index += 2) {
      output.write(Integer.parseInt(server.pin.substring(index, index + 2), 16));
    }
    output.write(new byte[24]);
    StringBuilder text = new StringBuilder("GRIGDESK:PAIR:1:");
    int bits = 0;
    int count = 0;
    String alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    for (byte value : output.toByteArray()) {
      bits = (bits << 8) | (value & 255);
      count += 8;
      while (count >= 5) {
        count -= 5;
        text.append(alphabet.charAt((bits >> count) & 31));
      }
    }
    if (count != 0) {
      text.append(alphabet.charAt((bits << (5 - count)) & 31));
    }
    return text.toString();
  }
}
