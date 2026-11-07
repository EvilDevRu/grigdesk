package local.grigdesk.client.shell;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import java.util.Locale;
import local.grigdesk.client.key.Pins;

public final class PairingPayload {
  private static final String PREFIX = "GRIGDESK:PAIR:1:";
  private static final String ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  public final String host;
  public final int port;
  public final String fp;
  public final String code;

  /**
   * Декодированная строка содержит адрес, точный pin и одноразовый код.
   * Значения переносятся без сетевых эффектов; проверка выполняется декодером.
   */
  public PairingPayload(String host, int port, String fp, String code) {
    this.host = host;
    this.port = port;
    this.fp = fp;
    this.code = code;
  }

  /**
   * Биты хвоста и длина конверта проверяются до появления сетевого адреса.
   * Нижний регистр и пробелы вокруг допускаются одинаково с общим TypeScript-кодеком.
   */
  public static PairingPayload decode(String text) {
    if (text == null || text.length() > 1024) {
      throw new IllegalArgumentException("invalid_pairing");
    }

    String normalized = text.trim().toUpperCase(Locale.ROOT);

    if (!normalized.startsWith(PREFIX)) {
      throw new IllegalArgumentException("invalid_pairing");
    }

    ByteArrayOutputStream output = new ByteArrayOutputStream();
    int value = 0;
    int available = 0;
    String encoded = normalized.substring(PREFIX.length());

    for (char character : encoded.toCharArray()) {
      int digit = ALPHABET.indexOf(character);

      if (digit < 0) {
        throw new IllegalArgumentException("invalid_pairing");
      }

      value = (value << 5) | digit;
      available += 5;

      if (available >= 8) {
        available -= 8;
        output.write((value >>> available) & 255);
      }

      value &= (1 << available) - 1;
    }

    byte[] bytes = output.toByteArray();

    if (value != 0 || encoded.length() != (bytes.length * 8 + 4) / 5 || bytes.length == 0) {
      throw new IllegalArgumentException("invalid_pairing");
    }

    String host;
    int offset;

    if (bytes[0] == 4 && bytes.length >= 5) {
      host = (bytes[1] & 255) + "." + (bytes[2] & 255) + "." + (bytes[3] & 255) + "." + (bytes[4] & 255);
      offset = 5;
    } else if (bytes[0] == 0x48 && bytes.length >= 2 && (bytes[1] & 255) + 2 <= bytes.length) {
      offset = 2 + (bytes[1] & 255);
      host = new String(bytes, 2, offset - 2, StandardCharsets.US_ASCII);
    } else {
      throw new IllegalArgumentException(bytes[0] == 0x06 ? "unsupported_address" : "invalid_pairing");
    }

    if (!host.matches("[a-z0-9.-]{1,253}") || bytes.length != offset + 58) {
      throw new IllegalArgumentException("invalid_pairing");
    }

    int port = ((bytes[offset] & 255) << 8) | (bytes[offset + 1] & 255);
    StringBuilder pin = new StringBuilder();

    for (byte item : Arrays.copyOfRange(bytes, offset + 2, offset + 34)) {
      pin.append(String.format(Locale.ROOT, "%02x", item & 255));
    }

    if (port == 0) {
      throw new IllegalArgumentException("invalid_pairing");
    }

    return new PairingPayload(host, port, pin.toString(), Base64.getUrlEncoder().withoutPadding()
      .encodeToString(Arrays.copyOfRange(bytes, offset + 34, bytes.length)));
  }
}
