package local.grigdesk.client.shell;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import local.grigdesk.client.pipe.HttpHead;
import local.grigdesk.client.pipe.PipeResponse;
import local.grigdesk.client.pipe.PipeTransport;
import local.grigdesk.client.pipe.StaticAssets;
import org.json.JSONObject;
import org.junit.Test;

public class ShellBackgroundLinkTest {
  private static ShellApi.Native recordingNative(List<String> calls, AtomicBoolean link) {
    return new ShellApi.Native() {
      public String scan() {
        return "";
      }
      public void save(String name, String type, InputStream body) {
      }
      public void unlock() {
      }
      public void setBackgroundLink(boolean enabled) {
        calls.add("link:" + enabled);
        link.set(enabled);
      }
    };
  }

  /**
   * Включённая фоновая связь сохраняет транспорт в фоне и отдаёт данные при закрытом gate.
   * Выключение возвращает прежнее поведение: фон закрывает трубу, gate скрывает выдачу.
   */
  @Test
  public void backgroundLinkKeepsTransportAliveAndBypassesGateForData() throws Exception {
    Path root = Files.createTempDirectory("grigdesk-shell-link-");
    Path file = root.resolve("profiles.json");
    ProfileStore store = new ProfileStore(file.toFile(), port -> true);
    String id = store.add("Фикстура", "https://machine.example:443", "1".repeat(64)).getString("id");
    AtomicBoolean link = new AtomicBoolean(false);
    AtomicBoolean locked = new AtomicBoolean(false);
    List<String> closes = new ArrayList<>();
    List<String> calls = new ArrayList<>();
    ShellApi.Gate gate = new ShellApi.Gate() {
      public boolean locked() {
        return locked.get();
      }
      public JSONObject snapshot() {
        return new JSONObject();
      }
      public void unlocked() {
        locked.set(false);
      }
      public void update(JSONObject data) {
      }
    };

    try (ShellApi shell = new ShellApi(store, null, (profile, version, report) -> new ShellApi.Transport() {
      public void probe() {
        report.accept("online", null);
      }
      public void close() {
        closes.add("close");
      }
      public PipeTransport pipe() {
        return new PipeTransport() {
          public PipeResponse forward(HttpHead head, InputStream body) {
            return null;
          }
          public void upgrade(HttpHead head, java.net.Socket downstream, InputStream input,
            java.util.concurrent.ExecutorService pool) {
          }
          public void probe() {
          }
          public void close() {
          }
        };
      }
    }, (callback, delay) -> () -> {}, Runnable::run, profile -> {}, recordingNative(calls, link),
      () -> 0.5, 0, 1, null, gate, link::get)) {
      store.select(id);
      shell.connect(id, true);

      assertFalse(shell.state.snapshot().getJSONObject("backgroundLink").getBoolean("enabled"));

      HttpHead request = new HttpHead("POST /__shell/background-link HTTP/1.1", java.util.Map.of());

      try (PipeResponse response = shell.handle(request,
        new ByteArrayInputStream(new JSONObject().put("enabled", true)
          .toString().getBytes(StandardCharsets.UTF_8)))) {
        JSONObject snapshot = new JSONObject(StaticAssets.readText(response.body, 4096));

        assertEquals(200, response.status);
        assertTrue(snapshot.getJSONObject("backgroundLink").getBoolean("enabled"));
      }

      assertEquals(List.of("link:true"), calls);

      locked.set(true);
      shell.suspend();

      assertTrue(closes.isEmpty());
      assertNotNull(shell.upstream(id));

      shell.resume(true);

      assertNotNull(shell.upstream(id));

      // Закрытый gate не даёт менять настройку: действия оболочки остаются под замком.
      try (PipeResponse response = shell.handle(request,
        new ByteArrayInputStream(new JSONObject().put("enabled", false)
          .toString().getBytes(StandardCharsets.UTF_8)))) {
        assertEquals(423, response.status);
      }

      locked.set(false);

      try (PipeResponse response = shell.handle(request,
        new ByteArrayInputStream(new JSONObject().put("enabled", false)
          .toString().getBytes(StandardCharsets.UTF_8)))) {
        assertEquals(200, response.status);
      }

      shell.suspend();

      assertEquals(List.of("close"), closes);
      assertNull(shell.upstream(id));
    } finally {
      Files.deleteIfExists(file);
      Files.deleteIfExists(root);
    }
  }

  /**
   * Неверные поля настройки отвергаются до нативного вызова и записи.
   * Оболочка без фоновой связи сохраняет снимок без блока и прежнее поведение фона.
   */
  @Test
  public void invalidFieldsRejectedAndLegacyShellHasNoBlock() throws Exception {
    Path root = Files.createTempDirectory("grigdesk-shell-link-invalid-");
    ProfileStore store = new ProfileStore(root.resolve("profiles.json").toFile(), port -> true);
    AtomicBoolean link = new AtomicBoolean(false);
    List<String> calls = new ArrayList<>();

    try (ShellApi shell = new ShellApi(store, null, null, (callback, delay) -> () -> {}, Runnable::run,
      id -> {}, recordingNative(calls, link), () -> 0.5, 0, 1, null, null, link::get)) {
      JSONObject[] invalid = new JSONObject[] {
        new JSONObject(),
        new JSONObject().put("enabled", "yes"),
        new JSONObject().put("enabled", true).put("extra", 1),
      };

      for (JSONObject input : invalid) {
        HttpHead request = new HttpHead("POST /__shell/background-link HTTP/1.1", java.util.Map.of());

        try (PipeResponse response = shell.handle(request,
          new ByteArrayInputStream(input.toString().getBytes(StandardCharsets.UTF_8)))) {
          assertEquals(400, response.status);
        }
      }

      assertTrue(calls.isEmpty());
      assertTrue(shell.state.snapshot().has("backgroundLink"));
    } finally {
      Files.deleteIfExists(root);
    }

    Path legacyRoot = Files.createTempDirectory("grigdesk-shell-link-legacy-");
    ProfileStore legacyStore = new ProfileStore(legacyRoot.resolve("profiles.json").toFile(), port -> true);

    try (ShellApi shell = new ShellApi(legacyStore, null, null, (callback, delay) -> () -> {},
      Runnable::run, id -> {}, null, () -> 0.5, 0, 1)) {
      assertFalse(shell.state.snapshot().has("backgroundLink"));
    } finally {
      Files.deleteIfExists(legacyRoot);
    }
  }
}
