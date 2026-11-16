package local.grigdesk.client.shell;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import local.grigdesk.client.pipe.HttpHead;
import local.grigdesk.client.pipe.PipeResponse;
import local.grigdesk.client.pipe.StaticAssets;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class ShellWidgetTest {
  /**
   * Снимок отдаёт возможности массивом строк без порядка и индексов.
   * Поиск по имени проверяет контракт, а не позицию в массиве.
   */
  private static boolean hasCapability(JSONArray capabilities, String name) {
    for (int index = 0; index < capabilities.length(); index++) {
      if (name.equals(capabilities.optString(index))) {
        return true;
      }
    }

    return false;
  }

  /**
   * Виджет принадлежит каждой оболочке с этим кодом: capability объявляется
   * без нативных действий, чтобы веб не ждал отдельного признака.
   */
  @Test
  public void snapshotDeclaresWidgetCapability() throws Exception {
    Path root = Files.createTempDirectory("grigdesk-shell-widget-cap-");
    ProfileStore store = new ProfileStore(root.resolve("profiles.json").toFile(), port -> true);

    try (ShellApi shell = new ShellApi(store, null, null, (callback, delay) -> () -> {},
      Runnable::run, id -> {}, null, () -> 0.5, 0, 1)) {
      JSONArray capabilities = shell.state.snapshot().getJSONArray("capabilities");

      assertTrue(hasCapability(capabilities, "widget"));
    } finally {
      Files.deleteIfExists(root);
    }
  }

  /**
   * Запрос обновления принимает только пустой объект и зовёт нативное действие.
   * Прежняя оболочка без нативных действий отвечает успехом без вызова.
   */
  @Test
  public void widgetRefreshCallsNativeAndAcceptsEmptyBodyOnly() throws Exception {
    Path root = Files.createTempDirectory("grigdesk-shell-widget-refresh-");
    ProfileStore store = new ProfileStore(root.resolve("profiles.json").toFile(), port -> true);
    List<String> calls = new ArrayList<>();
    ShellApi.Native nativeActions = new ShellApi.Native() {
      public String scan() {
        return "";
      }
      public void save(String name, String type, InputStream body) {
      }
      public void unlock() {
      }
      public void refreshWidget() {
        calls.add("refresh");
      }
    };

    try (ShellApi shell = new ShellApi(store, null, null, (callback, delay) -> () -> {},
      Runnable::run, id -> {}, nativeActions, () -> 0.5, 0, 1)) {
      HttpHead request = new HttpHead("POST /__shell/widget-refresh HTTP/1.1", Map.of());

      try (PipeResponse response = shell.handle(request,
        new ByteArrayInputStream("{}".getBytes(StandardCharsets.UTF_8)))) {
        assertEquals(200, response.status);
        assertTrue(new JSONObject(StaticAssets.readText(response.body, 4096)).getBoolean("ok"));
      }

      assertEquals(List.of("refresh"), calls);

      try (PipeResponse response = shell.handle(request,
        new ByteArrayInputStream(new JSONObject().put("enabled", true)
          .toString().getBytes(StandardCharsets.UTF_8)))) {
        assertEquals(400, response.status);
      }

      assertEquals(List.of("refresh"), calls);
    } finally {
      Files.deleteIfExists(root);
    }

    Path bareRoot = Files.createTempDirectory("grigdesk-shell-widget-bare-");
    ProfileStore bareStore = new ProfileStore(bareRoot.resolve("profiles.json").toFile(), port -> true);

    try (ShellApi shell = new ShellApi(bareStore, null, null, (callback, delay) -> () -> {},
      Runnable::run, id -> {}, null, () -> 0.5, 0, 1)) {
      HttpHead request = new HttpHead("POST /__shell/widget-refresh HTTP/1.1", Map.of());

      try (PipeResponse response = shell.handle(request,
        new ByteArrayInputStream("{}".getBytes(StandardCharsets.UTF_8)))) {
        assertEquals(200, response.status);
      }
    } finally {
      Files.deleteIfExists(bareRoot);
    }
  }

  /**
   * Закрытый gate пропускает обновление счётчиков как данные, но продолжает
   * блокировать действия интерфейса: оповещение остаётся под замком.
   */
  @Test
  public void widgetRefreshPassesClosedGateButNotifyDoesNot() throws Exception {
    Path root = Files.createTempDirectory("grigdesk-shell-widget-gate-");
    ProfileStore store = new ProfileStore(root.resolve("profiles.json").toFile(), port -> true);
    boolean[] locked = { true };
    ShellApi.Gate gate = new ShellApi.Gate() {
      public boolean locked() {
        return locked[0];
      }
      public JSONObject snapshot() {
        return new JSONObject();
      }
      public void unlocked() {
        locked[0] = false;
      }
      public void update(JSONObject data) {
      }
    };
    ShellApi.Native legacy = new ShellApi.Native() {
      public String scan() {
        return "";
      }
      public void save(String name, String type, InputStream body) {
      }
      public void unlock() {
      }
    };

    try (ShellApi shell = new ShellApi(store, null, null, (callback, delay) -> () -> {},
      Runnable::run, id -> {}, legacy, () -> 0.5, 0, 1, null, gate)) {
      HttpHead refresh = new HttpHead("POST /__shell/widget-refresh HTTP/1.1", Map.of());

      try (PipeResponse response = shell.handle(refresh,
        new ByteArrayInputStream("{}".getBytes(StandardCharsets.UTF_8)))) {
        assertEquals(200, response.status);
      }

      HttpHead notify = new HttpHead("POST /__shell/notify HTTP/1.1", Map.of());

      try (PipeResponse response = shell.handle(notify,
        new ByteArrayInputStream(new JSONObject().put("title", "t")
          .toString().getBytes(StandardCharsets.UTF_8)))) {
        assertEquals(423, response.status);
      }
    } finally {
      Files.deleteIfExists(root);
    }
  }
}
