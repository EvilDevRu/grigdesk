package local.grigdesk.client.shell;

import static org.junit.Assert.*;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class PairingPayloadTest {
  /**
   * Java принимает и отвергает те же общие векторы, что кодек TypeScript.
   * Неверные длины, адреса и зарезервированный IPv6 сохраняют точный код отказа.
   */
  @Test
  public void sharedVectorsAreTheSameOnJava() throws Exception {
    String source = new String(Files.readAllBytes(Paths.get("../../../tests/fixtures/pairing-vectors.json")),
      StandardCharsets.UTF_8);
    JSONObject vectors = new JSONObject(source);
    JSONArray valid = vectors.getJSONArray("valid");

    for (int index = 0; index < valid.length(); index++) {
      JSONObject row = valid.getJSONObject(index);
      JSONObject expected = row.getJSONObject("payload");
      PairingPayload payload = PairingPayload.decode("  " + row.getString("text").toLowerCase() + "  ");

      assertEquals(expected.getString("host"), payload.host);
      assertEquals(expected.getInt("port"), payload.port);
      assertEquals(expected.getString("fp"), payload.fp);
      assertEquals(expected.getString("code"), payload.code);
    }

    JSONArray invalid = vectors.getJSONArray("invalid");

    for (int index = 0; index < invalid.length(); index++) {
      JSONObject row = invalid.getJSONObject(index);
      IllegalArgumentException failure = assertThrows(IllegalArgumentException.class,
        () -> PairingPayload.decode(row.getString("text")));

      assertEquals(row.getString("code"), failure.getMessage());
    }
  }
}
