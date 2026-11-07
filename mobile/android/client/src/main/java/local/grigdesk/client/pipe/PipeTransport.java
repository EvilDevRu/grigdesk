package local.grigdesk.client.pipe;

import java.io.InputStream;
import java.net.Socket;
import java.util.concurrent.ExecutorService;

public interface PipeTransport extends AutoCloseable {
  PipeResponse forward(HttpHead head, InputStream body) throws Exception;
  void upgrade(HttpHead head, Socket downstream, InputStream input, ExecutorService pool) throws Exception;
  void probe() throws Exception;
  void close();
}
