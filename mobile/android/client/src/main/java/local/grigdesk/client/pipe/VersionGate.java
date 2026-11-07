package local.grigdesk.client.pipe;

public final class VersionGate {
  private final int major;
  private final int minor;
  private String failure;
  private String server;

  public VersionGate(int major, int minor) {
    this.major = major;
    this.minor = minor;
  }

  /**
   * Защёлка остаётся закрытой и для поздних ответов параллельных запросов.
   * Только новый транспорт после действия человека создаёт новую проверку версии.
   */
  public synchronized String check(String header, int status) {
    if (status == 101) {
      return null;
    }

    if (failure != null) {
      return failure;
    }

    if (header == null || !header.matches("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)")) {
      failure = "server_upgrade_required";

      return failure;
    }

    server = header;

    try {
      String[] parts = header.split("\\.");
      long remoteMajor = Long.parseLong(parts[0]);
      long remoteMinor = Long.parseLong(parts[1]);

      if (remoteMajor > major) {
        failure = "client_upgrade_required";
      } else if (remoteMajor < major || remoteMinor < minor) {
        failure = "server_upgrade_required";
      }
    } catch (NumberFormatException exception) {
      failure = "client_upgrade_required";
    }

    return failure;
  }

  public synchronized String failure() {
    return failure;
  }

  public synchronized String server() {
    return server;
  }
}
