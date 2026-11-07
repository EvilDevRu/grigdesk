package local.grigdesk.mobile.link;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Случайный IPv4 loopback порт пересылает только зашифрованные байты brain TLS.
 * Бюджет восьми пар и фиксированный pool ограничивают sockets и потоки телефона.
 */
public final class LocalForwarder implements AutoCloseable {

  private final RelayDialer dialer;
  private final NativeSession session;
  private final long generation;
  private final java.util.function.Consumer<Throwable> failure;
  private final Set<Pair> pairs = new HashSet<>();
  private final ThreadPoolExecutor pool = new ThreadPoolExecutor(
    24,
    24,
    0,
    TimeUnit.SECONDS,
    new ArrayBlockingQueue<>(24),
    new ThreadPoolExecutor.AbortPolicy()
  );
  private ServerSocket listener;
  private Thread acceptThread;
  private volatile boolean closed;

  public LocalForwarder(RelayDialer dialer, NativeSession session, long generation) {
    this(dialer, session, generation, error -> {
    });
  }

  public LocalForwarder(
    RelayDialer dialer,
    NativeSession session,
    long generation,
    java.util.function.Consumer<Throwable> failure
  ) {
    this.dialer = dialer;
    this.session = session;
    this.generation = generation;
    this.failure = failure;
  }

  /**
   * Listener создаётся только для текущего unlock и всегда на 127.0.0.1.
   * Поздний dial не добавляет пару после close или смены generation.
   */
  public synchronized void start() throws Exception {
    session.require(generation);

    if (listener != null || closed) {
      throw new IllegalStateException("Forwarder уже создан");
    }

    listener = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
    acceptThread = new Thread(this::accept, "grigdesk-forwarder");
    acceptThread.start();
  }

  public synchronized int port() {
    if (listener == null || closed) {
      throw new IllegalStateException("locked");
    }

    return listener.getLocalPort();
  }

  public synchronized int activePairs() {
    return pairs.size();
  }

  /**
   * Приём не создаёт необbounded очередь: девятое соединение закрывается сразу.
   * Каждая допущенная пара закрывает обе стороны при ошибке или EOF.
   */
  private void accept() {
    while (!closed) {
      try {
        Socket local = listener.accept();
        Pair pair = new Pair(local);

        synchronized (this) {
          if (closed || !session.isCurrent(generation) || pairs.size() >= 8) {
            local.close();
            continue;
          }

          pairs.add(pair);
        }
        pool.execute(() -> connect(pair));
      } catch (Exception exception) {
        if (!closed) {
          close();
        }
      }
    }
  }

  /**
   * Raw socket регистрируется внутри пары до connect, поэтому lock отменяет и зависший dial.
   * Два copy потока используют bounded буфер и blocking write для backpressure.
   */
  private void connect(Pair pair) {
    try {
      session.require(generation);

      Socket remote = dialer.open(pair::track);

      session.require(generation);

      if (closed || pair.finished.get()) {
        remote.close();
        pair.close();

        return;
      }

      pool.execute(() -> copy(pair, pair.local, remote));
      pool.execute(() -> copy(pair, remote, pair.local));
    } catch (Exception exception) {
      pair.close();
      failure.accept(exception);
    }
  }

  /**
   * Поток не материализует весь туннель в памяти и не декодирует TLS байты.
   * Закрытие одного направления отменяет обе стороны и освобождает slot пары.
   */
  private void copy(Pair pair, Socket source, Socket destination) {
    try {
      byte[] buffer = new byte[16384];
      InputStream input = source.getInputStream();
      OutputStream output = destination.getOutputStream();
      int read;

      while (!closed && !pair.finished.get() && (read = input.read(buffer)) >= 0) {
        session.require(generation);
        output.write(buffer, 0, read);
      }
    } catch (Exception exception) {
      // Ошибка означает закрытие пары; содержимое TLS никогда не попадает в журнал.
      // Повторное соединение создаётся владельцем REST/SSE после общей проверки сессии.
    } finally {
      pair.close();
    }
  }

  /**
   * Close отменяет listener, pending dial и оба copy направления каждой пары.
   * Pool не используется снова после unlock: новая сессия получает новый forwarder.
   */
  @Override
  public synchronized void close() {
    if (closed) {
      return;
    }

    closed = true;

    try {
      if (listener != null) {
        listener.close();
      }
    } catch (Exception exception) {
      // Listener уже может быть закрыт сетевой ошибкой.
      // Освобождение остальных пар всё равно обязательно.
    }

    for (Pair pair : new HashSet<>(pairs)) {
      pair.close();
    }

    pool.shutdownNow();
  }

  private final class Pair {

    final Socket local;
    final Set<Socket> owned = new java.util.LinkedHashSet<>();
    final AtomicBoolean finished = new AtomicBoolean();

    Pair(Socket local) {
      this.local = local;
      owned.add(local);
    }

    /**
     * Socket регистрируется до зависающих операций connect и TLS handshake.
     * Уже закрытая пара немедленно закрывает поздний socket вместо добавления в pool.
     */
    synchronized void track(Socket socket) {
      if (finished.get()) {
        try {
          socket.close();
        } catch (Exception exception) {
          // Поздний socket принадлежит уже закрытой паре.
          // Повторный dial возможен только в новом поколении.
        }
      } else {
        owned.add(socket);
      }
    }

    /**
     * Освобождение slot синхронизируется с listener, а sockets закрываются один раз.
     * Поздняя регистрация socket видит finished и не воскрешает соединение.
     */
    void close() {
      if (!finished.compareAndSet(false, true)) {
        return;
      }

      synchronized (this) {
        for (Socket socket : owned) {
          try {
            socket.close();
          } catch (Exception exception) {
            // Отказ одного close не отменяет освобождение остальных sockets.
            // Raw socket закрывается раньше TLS wrapper, исключая ожидание close_notify.
          }
        }

        owned.clear();
      }
      synchronized (LocalForwarder.this) {
        pairs.remove(this);
      }
    }
  }
}
