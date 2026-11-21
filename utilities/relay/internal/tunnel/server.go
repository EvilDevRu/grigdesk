package tunnel

import (
	"bufio"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"errors"
	"net"
	"slices"
	"strconv"
	"sync"
	"time"

	"grigdesk.local/tools/utilities/relay/internal/protocol"
)

const BindHost = "0.0.0.0"

type Logger func(string, int)
type HealthProof func(protocol.Hello) protocol.Reply

type server struct {
	config  Config
	log     Logger
	proof   HealthProof
	mu      sync.Mutex
	sockets map[net.Conn]string
	pending map[string]*pending
	control *peer
	client  bool
	limits  map[string]*limitEntry
}

type peer struct {
	raw   net.Conn
	conn  *tls.Conn
	input *bufio.Reader
	mu    sync.Mutex
}

// Serve начинает принимать соединения только после успешного bind и startup hook.
// Отмена закрывает listener и все потоки этого процесса до возврата.
func Serve(ctx context.Context, config Config, log Logger, proof HealthProof, started func()) error {
	listener, err := (&net.ListenConfig{}).Listen(ctx, "tcp4", net.JoinHostPort(BindHost, strconv.Itoa(config.Port)))
	if err != nil {
		return err
	}
	return ServeListener(ctx, listener, config, log, proof, started)
}

// ServeListener выполняет тот же протокол на уже открытом слушателе и закрывает его при выходе.
func ServeListener(
	ctx context.Context, listener net.Listener, config Config, log Logger, proof HealthProof, started func(),
) error {
	defer listener.Close()
	relay := &server{
		config:  config,
		log:     log,
		proof:   proof,
		sockets: make(map[net.Conn]string),
		pending: make(map[string]*pending),
		limits:  make(map[string]*limitEntry),
	}
	stop := context.AfterFunc(ctx, func() {
		_ = listener.Close()
		relay.closeAll()
	})
	defer stop()
	sweepStopped := make(chan struct{})
	defer close(sweepStopped)
	go relay.sweepLoop(sweepStopped)
	port := listener.Addr().(*net.TCPAddr).Port
	log("listening", port)
	started()
	return relay.acceptLoop(ctx, listener)
}

// acceptLoop резервирует слот до TLS и дожидается освобождения всех принятых слотов.
// Ошибка accept при штатном закрытии не считается сбоем worker.
func (s *server) acceptLoop(ctx context.Context, listener net.Listener) error {
	var active sync.WaitGroup
	defer func() {
		s.closeAll()
		active.Wait()
	}()
	security := &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{s.config.Certificate}}
	for {
		raw, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		if !s.acquire(raw) {
			_ = raw.Close()
			continue
		}
		active.Add(1)
		go func() {
			defer active.Done()
			defer s.release(raw)
			defer raw.Close()
			s.handle(ctx, raw, security)
		}()
	}
}

// handle разделяет TLS handshake и bounded hello с отдельными сроками.
// Токен проверяется до регистрации control или перемещения pending.
func (s *server) handle(ctx context.Context, raw net.Conn, config *tls.Config) {
	conn := tls.Server(raw, config)
	_ = raw.SetDeadline(time.Now().Add(s.config.HelloTimeout))
	if err := conn.HandshakeContext(ctx); err != nil {
		s.log("tls_error", 0)
		return
	}
	if TCP, ok := raw.(*net.TCPConn); ok {
		_ = TCP.SetKeepAliveConfig(net.KeepAliveConfig{Enable: true, Idle: 30 * time.Second})
		_ = TCP.SetNoDelay(true)
	}
	p := &peer{raw: raw, conn: conn, input: bufio.NewReaderSize(conn, protocol.Maximum+1)}
	_ = raw.SetDeadline(time.Now().Add(s.config.HelloTimeout))
	if s.banned(raw) {
		p.fail("banned")
		return
	}
	line, err := protocol.ReadLine(p.input)
	if err != nil {
		if err.Error() == "bad_hello" {
			p.fail("bad_hello")
		}
		return
	}
	if p.input.Buffered() != 0 {
		p.fail("bad_hello")
		return
	}
	hello, err := protocol.ParseHello(line)
	if err != nil {
		p.fail(err.Error())
		return
	}
	_ = raw.SetDeadline(time.Time{})

	if hello.Role == "health" {
		reply := protocol.Reply{OK: true}
		if hello.Proof != nil {
			reply = protocol.Reply{Error: "bad_deployment_proof"}
			if s.proof != nil {
				reply = s.proof(hello)
			}
		}
		_ = p.write(reply)
		return
	}
	if !s.authenticated(hello) {
		s.failure(raw)
		p.fail("unauthorized")
		return
	}
	key := hello.Target
	switch hello.Role {
	case "brain-control":
		s.controlLoop(ctx, p, slices.Contains(hello.Capabilities, "client-v2"))
	case "device":
		s.waitDevice(p, key)
	case "brain-data":
		s.dataPeer(ctx, p, hello.ID, key)
	}
}

// authenticated сравнивает SHA256 токена в постоянное время с пином нужной роли.
// Значение токена не сохраняется после проверки hello.
func (s *server) authenticated(hello protocol.Hello) bool {
	expected := s.config.BrainHash
	if hello.Role == "device" {
		expected = s.config.DeviceHash
	}
	digest := sha256.Sum256([]byte(hello.Token))
	return subtle.ConstantTimeCompare(expected[:], digest[:]) == 1
}

// write последовательно отправляет один кадр протокола и восстанавливает срок записи.
// Control использует этого короткоживущего writer для всех независимых источников событий.
func (p *peer) write(value any) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	_ = p.raw.SetWriteDeadline(time.Now().Add(time.Second))
	defer p.raw.SetWriteDeadline(time.Time{})
	return protocol.Write(p.conn, value)
}

func (p *peer) fail(code string) {
	_ = p.write(protocol.Reply{Error: code})
}

// closeAll прекращает принадлежащие серверу соединения без отправки новых кадров.
// Состояние pending одновременно остаётся защищено своей блокировкой.
func (s *server) closeAll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for socket := range s.sockets {
		_ = socket.Close()
	}
}
