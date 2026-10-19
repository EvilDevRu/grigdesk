package local.grigdesk.client.pipe;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.junit.Test;

public class StreamingTest {
  /**
   * Большое тело и ответ неизвестной длины передаются без полного накопления.
   * Первое событие SSE наблюдается до задержанного второго события.
   */
  @Test
  public void largePostChunkedAndSseAreStreams() throws Exception {
    byte[] large = new byte[5 * 1024 * 1024];

    new java.util.Random(17).nextBytes(large);

    try (TlsFixture server = new TlsFixture((head, body, output) -> {
      if (head.method().equals("POST")) {
        byte[] received = body.readAllBytes();

        TlsFixture.response(output, 200, "0.1", received);
      } else {
        output.write(("HTTP/1.1 200 OK\r\nX-GrigDesk-Api: 0.1\r\n"
          + "Content-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n"
          + "9\r\ndata: 1\n\n\r\n").getBytes(StandardCharsets.US_ASCII));
        output.flush();
        Thread.sleep(1000);
        output.write("9\r\ndata: 2\n\n\r\n0\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
        output.flush();
      }
    }); Upstream upstream = new Upstream(server.address(), server.pin, TlsFixture.keys("client"),
      new VersionGate(0, 1), (status, code) -> {});
      ClientPipe pipe = new ClientPipe(0, "fixture-secret", ClientPipeTest.assets(), () -> upstream,
        (head, body) -> PipeResponse.error(404, "unknown"))) {
      try (Socket socket = new Socket("127.0.0.1", pipe.port())) {
        socket.setSoTimeout(3000);
        socket.getOutputStream().write(("POST /api/upload HTTP/1.1\r\nHost: 127.0.0.1:" + pipe.port()
          + "\r\nCookie: grigdesk_pipe=fixture-secret\r\nContent-Length: " + large.length
          + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        socket.getOutputStream().write(large);
        socket.getOutputStream().flush();

        HttpHead response = HttpHead.read(socket.getInputStream());

        assertEquals(200, response.status());
        assertArrayEquals(large, BodyFraming.input(response, socket.getInputStream()).readAllBytes());
      }

      long start = System.nanoTime();

      try (Socket socket = new Socket("127.0.0.1", pipe.port())) {
        socket.setSoTimeout(3000);

        HttpHead response = ClientPipeTest.send(socket, pipe.port(), "GET /api/events",
          "Cookie: grigdesk_pipe=fixture-secret\r\n");
        InputStream body = BodyFraming.input(response, socket.getInputStream());

        assertEquals("data: 1\n\n", new String(body.readNBytes(9), StandardCharsets.US_ASCII));
        assertTrue("Первое событие задержано", (System.nanoTime() - start) / 1000000 < 500);
        assertEquals("data: 2\n\n", new String(body.readAllBytes(), StandardCharsets.US_ASCII));
        assertTrue((System.nanoTime() - start) / 1000000 >= 1000);
      }

      byte[] framed = "3\r\nabc\r\n2\r\nde\r\n0\r\n\r\nNEXT".getBytes(StandardCharsets.US_ASCII);
      ByteArrayInputStream input = new ByteArrayInputStream(framed);
      BodyFraming.Frame body = BodyFraming.input(new HttpHead("POST /api/x HTTP/1.1",
        Map.of("transfer-encoding", "chunked")), input);

      assertEquals("abcde", new String(body.readAllBytes(), StandardCharsets.US_ASCII));
      assertTrue(body.complete());
      assertEquals("NEXT", new String(input.readAllBytes(), StandardCharsets.US_ASCII));

      ByteArrayOutputStream output = new ByteArrayOutputStream();

      BodyFraming.output(new ByteArrayInputStream("abc".getBytes(StandardCharsets.US_ASCII)), output, -1);
      assertEquals("3\r\nabc\r\n0\r\n\r\n", output.toString(StandardCharsets.US_ASCII));
    }
  }

  /**
   * Настоящий TLS-upgrade пропускает исходный бинарный кадр в обе стороны.
   * Текстовое декодирование не вмешивается в содержимое туннеля.
   */
  @Test
  public void rawUpgradeEchoPreservesBinaryFrame() throws Exception {
    byte[] frame = new byte[] { (byte) 0x82, (byte) 0x83, 1, 2, 3, 4, 0, (byte) 255, 17 };

    try (TlsFixture server = new TlsFixture((head, input, output) -> {
      output.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
        + "Connection: Upgrade\r\nSet-Cookie: forbidden=1\r\n\r\n")
        .getBytes(StandardCharsets.US_ASCII));
      output.flush();
      output.write(input.readNBytes(frame.length));
      output.flush();
    }); Upstream upstream = new Upstream(server.address(), server.pin, TlsFixture.keys("client"),
      new VersionGate(0, 1), (status, code) -> {});
      ClientPipe pipe = new ClientPipe(0, "fixture-secret", ClientPipeTest.assets(), () -> upstream,
        (head, body) -> PipeResponse.error(404, "unknown"));
      Socket socket = new Socket("127.0.0.1", pipe.port())) {
      socket.setSoTimeout(3000);

      HttpHead response = ClientPipeTest.send(socket, pipe.port(), "GET /api/socket",
        "Cookie: grigdesk_pipe=fixture-secret\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n");

      assertEquals(101, response.status());
      assertNull(response.headers.get("set-cookie"));
      socket.getOutputStream().write(frame);
      socket.getOutputStream().flush();
      assertArrayEquals(frame, socket.getInputStream().readNBytes(frame.length));
    }
  }
}
