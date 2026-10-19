package local.grigdesk.client.key;

/**
 * Утраченный ключ требует явной новой привязки, вместо автоматической смены личности.
 * Сообщение не содержит alias, сертификат или сведения о машине.
 */
public final class MissingDeviceKeyException extends Exception {
  public MissingDeviceKeyException() {
    super("Ключ устройства утрачен. Привяжите машину заново.");
  }
}
