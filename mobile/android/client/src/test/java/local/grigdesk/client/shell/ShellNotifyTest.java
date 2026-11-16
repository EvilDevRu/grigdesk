package local.grigdesk.client.shell;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import local.grigdesk.client.pipe.HttpHead;
import local.grigdesk.client.pipe.PipeResponse;
import local.grigdesk.client.pipe.StaticAssets;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class ShellNotifyTest {
  private static boolean hasCapability(JSONArray capabilities, String name) {
    for (int index = 0; index < capabilities.length(); index++) {
      if (name.equals(capabilities.optString(index))) {
        return true;
      }
    }

    return false;
  }

  /**
   * Нативный канал получает проверенные поля и возвращает факт показа с разрешением.
   * Запись вызова проверяет порядок аргументов без реального Android.
   */
  @Test
  public void notifyEndpointPassesValidatedFieldsAndReportsShown() throws Exception {
    Path root = Files.createTempDirectory("grigdesk-shell-notify-");
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
      public String notifyPermission() {
        return "granted";
      }
      public String requestNotifyPermission() {
        return "granted";
      }
      public boolean notify(String title, String body, String tag, String url) {
        calls.add(title + "|" + body + "|" + tag + "|" + url);

        return true;
      }
      public void cancelNotification(String tag) {
        calls.add("cancel:" + tag);
      }
    };

    try (ShellApi shell = new ShellApi(store, null, null, (callback, delay) -> () -> {}, Runnable::run,
      id -> {}, nativeActions, () -> 0.5, 0, 1)) {
      JSONObject input = new JSONObject()
        .put("title", "Агент ответил")
        .put("body", "Готово")
        .put("tag", "chat-1")
        .put("url", "http://127.0.0.1:47101/#/chats?openChat=c1");
      HttpHead request = new HttpHead("POST /__shell/notify HTTP/1.1", java.util.Map.of());

      try (PipeResponse response = shell.handle(request,
        new ByteArrayInputStream(input.toString().getBytes(StandardCharsets.UTF_8)))) {
        JSONObject result = new JSONObject(StaticAssets.readText(response.body, 4096));

        assertEquals(200, response.status);
        assertTrue(result.getBoolean("shown"));
        assertEquals("granted", result.getString("permission"));
      }

      assertEquals(List.of("Агент ответил|Готово|chat-1|http://127.0.0.1:47101/#/chats?openChat=c1"),
        calls);

      HttpHead cancel = new HttpHead("POST /__shell/notify-cancel HTTP/1.1", java.util.Map.of());

      try (PipeResponse response = shell.handle(cancel,
        new ByteArrayInputStream(new JSONObject().put("tag", "chat-1")
          .toString().getBytes(StandardCharsets.UTF_8)))) {
        assertEquals(200, response.status);
      }

      assertEquals(List.of("Агент ответил|Готово|chat-1|http://127.0.0.1:47101/#/chats?openChat=c1",
        "cancel:chat-1"), calls);
    } finally {
      Files.deleteIfExists(root);
    }
  }

  /**
   * Пустой заголовок, чужой тип и превышение длины отвергаются до нативного вызова.
   * Отсутствующие необязательные поля становятся пустыми строками.
   */
  @Test
  public void notifyRejectsInvalidFieldsBeforeNativeCall() throws Exception {
    Path root = Files.createTempDirectory("grigdesk-shell-notify-invalid-");
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
      public boolean notify(String title, String body, String tag, String url) {
        calls.add(title);

        return true;
      }
    };

    try (ShellApi shell = new ShellApi(store, null, null, (callback, delay) -> () -> {}, Runnable::run,
      id -> {}, nativeActions, () -> 0.5, 0, 1)) {
      JSONObject[] invalid = new JSONObject[] {
        new JSONObject(),
        new JSONObject().put("title", "   "),
        new JSONObject().put("title", 42),
        new JSONObject().put("title", "x".repeat(201)),
        new JSONObject().put("title", "t").put("body", "x".repeat(2001)),
        new JSONObject().put("title", "t").put("tag", new JSONObject()),
        new JSONObject().put("title", "t").put("url", "x".repeat(2049)),
      };

      for (JSONObject input : invalid) {
        HttpHead request = new HttpHead("POST /__shell/notify HTTP/1.1", java.util.Map.of());

        try (PipeResponse response = shell.handle(request,
          new ByteArrayInputStream(input.toString().getBytes(StandardCharsets.UTF_8)))) {
          assertEquals(400, response.status);
        }
      }

      assertTrue(calls.isEmpty());

      HttpHead request = new HttpHead("POST /__shell/notify HTTP/1.1", java.util.Map.of());

      try (PipeResponse response = shell.handle(request,
        new ByteArrayInputStream(new JSONObject().put("title", "t")
          .toString().getBytes(StandardCharsets.UTF_8)))) {
        assertEquals(200, response.status);
      }

      assertEquals(List.of("t"), calls);
    } finally {
      Files.deleteIfExists(root);
    }
  }

  /**
   * Чтение и запрос разрешения возвращают состояние нативного канала.
   * Оболочка без нативных действий объявляет unsupported и не показывает оповещение.
   */
  @Test
  public void permissionEndpointsAndShellWithoutNativeRemainUnsupported() throws Exception {
    Path root = Files.createTempDirectory("grigdesk-shell-notify-permission-");
    ProfileStore store = new ProfileStore(root.resolve("profiles.json").toFile(), port -> true);
    ShellApi.Native nativeActions = new ShellApi.Native() {
      public String scan() {
        return "";
      }
      public void save(String name, String type, InputStream body) {
      }
      public void unlock() {
      }
      public String notifyPermission() {
        return "default";
      }
      public String requestNotifyPermission() {
        return "denied";
      }
    };

    try (ShellApi shell = new ShellApi(store, null, null, (callback, delay) -> () -> {}, Runnable::run,
      id -> {}, nativeActions, () -> 0.5, 0, 1)) {
      HttpHead read = new HttpHead("GET /__shell/notify-permission HTTP/1.1", java.util.Map.of());

      try (PipeResponse response = shell.handle(read, new ByteArrayInputStream(new byte[0]))) {
        assertEquals(200, response.status);
        assertEquals("default",
          new JSONObject(StaticAssets.readText(response.body, 4096)).getString("permission"));
      }

      HttpHead request = new HttpHead("POST /__shell/notify-permission HTTP/1.1", java.util.Map.of());

      try (PipeResponse response = shell.handle(request, new ByteArrayInputStream(new byte[0]))) {
        assertEquals(200, response.status);
        assertEquals("denied",
          new JSONObject(StaticAssets.readText(response.body, 4096)).getString("permission"));
      }

      JSONArray capabilities = shell.state.snapshot().getJSONArray("capabilities");

      assertTrue(hasCapability(capabilities, "notify"));
    } finally {
      Files.deleteIfExists(root);
    }

    Path bareRoot = Files.createTempDirectory("grigdesk-shell-notify-bare-");
    ProfileStore bareStore = new ProfileStore(bareRoot.resolve("profiles.json").toFile(), port -> true);

    try (ShellApi shell = new ShellApi(bareStore, null, null, (callback, delay) -> () -> {},
      Runnable::run, id -> {}, null, () -> 0.5, 0, 1)) {
      assertFalse(hasCapability(shell.state.snapshot().getJSONArray("capabilities"), "notify"));

      HttpHead read = new HttpHead("GET /__shell/notify-permission HTTP/1.1", java.util.Map.of());

      try (PipeResponse response = shell.handle(read, new ByteArrayInputStream(new byte[0]))) {
        assertEquals("unsupported",
          new JSONObject(StaticAssets.readText(response.body, 4096)).getString("permission"));
      }

      HttpHead request = new HttpHead("POST /__shell/notify HTTP/1.1", java.util.Map.of());

      try (PipeResponse response = shell.handle(request,
        new ByteArrayInputStream(new JSONObject().put("title", "t")
          .toString().getBytes(StandardCharsets.UTF_8)))) {
        JSONObject result = new JSONObject(StaticAssets.readText(response.body, 4096));

        assertEquals(200, response.status);
        assertFalse(result.getBoolean("shown"));
        assertEquals("unsupported", result.getString("permission"));
      }
    } finally {
      Files.deleteIfExists(bareRoot);
    }
  }

  /**
   * Прежняя реализация Native без методов оповещения сохраняет контракт unsupported.
   * Закрытый gate отвергает показ и запрос разрешения так же, как прочие действия.
   */
  @Test
  public void legacyNativeDefaultsToUnsupportedAndGateBlocksNotify() throws Exception {
    Path root = Files.createTempDirectory("grigdesk-shell-notify-gate-");
    ProfileStore store = new ProfileStore(root.resolve("profiles.json").toFile(), port -> true);
    ShellApi.Native legacy = new ShellApi.Native() {
      public String scan() {
        return "";
      }
      public void save(String name, String type, InputStream body) {
      }
      public void unlock() {
      }
    };
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

    try (ShellApi shell = new ShellApi(store, null, null, (callback, delay) -> () -> {}, Runnable::run,
      id -> {}, legacy, () -> 0.5, 0, 1, null, gate)) {
      HttpHead request = new HttpHead("POST /__shell/notify HTTP/1.1", java.util.Map.of());

      try (PipeResponse response = shell.handle(request,
        new ByteArrayInputStream(new JSONObject().put("title", "t")
          .toString().getBytes(StandardCharsets.UTF_8)))) {
        assertEquals(423, response.status);
      }

      locked[0] = false;

      try (PipeResponse response = shell.handle(request,
        new ByteArrayInputStream(new JSONObject().put("title", "t")
          .toString().getBytes(StandardCharsets.UTF_8)))) {
        JSONObject result = new JSONObject(StaticAssets.readText(response.body, 4096));

        assertEquals(200, response.status);
        assertFalse(result.getBoolean("shown"));
        assertEquals("unsupported", result.getString("permission"));
      }
    } finally {
      Files.deleteIfExists(root);
    }
  }
}
