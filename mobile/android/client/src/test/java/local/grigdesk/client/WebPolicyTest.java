package local.grigdesk.client;

import static org.junit.Assert.*;
import java.util.HashSet;
import java.util.Set;
import org.junit.Test;

public class WebPolicyTest {
  /**
   * Разрешены только зарегистрированные origin собственных труб.
   * Похожий host, другой протокол и файловые схемы не расширяют доверие WebView.
   */
  @Test
  public void onlyRegisteredPipeOriginsNavigate() {
    Set<String> origins = new HashSet<>();
    origins.add("http://127.0.0.1:47100");
    WebPolicy policy = new WebPolicy(origins);

    assertTrue(policy.navigation("http://127.0.0.1:47100/#/chats"));
    assertFalse(policy.navigation("http://127.0.0.1:47101/"));
    assertFalse(policy.navigation("https://127.0.0.1:47100/"));
    assertFalse(policy.navigation("http://user@127.0.0.1:47100/"));
    assertFalse(policy.navigation("file:///etc/passwd"));
    assertFalse(policy.navigation("content://private/file"));
    assertFalse(policy.navigation("javascript:alert(1)"));
    assertFalse(policy.navigation("http://127.0.0.1.example:47100/"));
    origins.add("http://127.0.0.1:47101");
    assertTrue(policy.navigation("http://127.0.0.1:47101/#/settings"));
  }

  /**
   * Микрофон выдаётся собственному origin без права на камеру.
   * Чужой origin и другой набор ресурсов получают отказ.
   */
  @Test
  public void microphoneOnlyForOwnOriginAndAudio() {
    WebPolicy policy = new WebPolicy(Set.of("http://127.0.0.1:47100"));
    String[] audio = { "android.webkit.resource.AUDIO_CAPTURE" };

    assertTrue(policy.microphone("http://127.0.0.1:47100/", audio));
    assertFalse(policy.microphone("https://other.example/", audio));
    assertFalse(policy.microphone("http://127.0.0.1:47100/", new String[] {
      "android.webkit.resource.VIDEO_CAPTURE"
    }));
  }
}
