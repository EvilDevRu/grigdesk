package local.grigdesk.client.shell;

import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class PhonePairingPayloadTest {
  /**
   * Java принимает и отвергает тот же неизменяемый набор PHONE:2, что TypeScript.
   * Ожидания берутся из общего тестового вектора, а не из другого продуктового кодека.
   */
  @Test
  public void sharedVectors() throws Exception {
    JSONObject vectors = new JSONObject(new String(Files.readAllBytes(
      Paths.get("../../../tests/fixtures/phone-pairing-vectors.json")), StandardCharsets.UTF_8));
    JSONArray valid = vectors.getJSONArray("valid");

    for (int index = 0; index < valid.length(); index++) {
      JSONObject row = valid.getJSONObject(index);
      JSONObject expected = row.getJSONObject("payload");
      JSONObject actual = PhonePairingPayload.decode(row.getString("text"));

      assertEquals(2, actual.getInt("v"));
      assertEquals(expected.getJSONObject("server").getString("fp"),
        actual.getJSONObject("server").getString("fp"));
      assertEquals(expected.getJSONObject("server").getString("name"),
        actual.getJSONObject("server").getString("name"));
      assertEquals(expected.getJSONArray("direct").toString(), actual.getJSONArray("direct").toString());
      assertEquals(expected.getJSONObject("pair").toString(), actual.getJSONObject("pair").toString());
      assertEquals(expected.has("relay"), actual.has("relay"));

      if (expected.has("relay")) {
        assertEquals(expected.getJSONObject("relay").toString(), actual.getJSONObject("relay").toString());
      }
    }

    JSONArray invalid = vectors.getJSONArray("invalid");

    for (int index = 0; index < invalid.length(); index++) {
      String text = invalid.getJSONObject(index).getString("text");

      assertThrows(IllegalArgumentException.class, () -> PhonePairingPayload.decode(text));
    }
  }
}
