package grigdeskapi

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Policy struct {
	Header              http.Header
	IdleTimeout         time.Duration
	FollowReadRedirects bool

	// ReadLimit возвращает максимальное число байтов, 0 или -1 для пропуска или чтения целиком.
	ReadLimit func(status int, header http.Header) int64
}

type Response struct {
	Status    int
	Header    http.Header
	Body      []byte
	Truncated bool
}

// Request выполняет прямой HTTP-вызов и читает ответ в пределах политики вызывающего.
// Перенаправления выполняются только для чтения, если команда явно их разрешает.
func Request(ctx context.Context, method, endpoint string, body []byte, policy Policy) (Response, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}

	request, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return Response{}, err
	}
	request.GetBody = nil
	if policy.Header != nil {
		request.Header = policy.Header.Clone()
	}
	if _, exists := request.Header["User-Agent"]; !exists {
		request.Header.Set("User-Agent", "")
	}

	transport := &http.Transport{
		DisableKeepAlives:  true,
		DisableCompression: true,
		DialContext:        dialWithIdleTimeout(policy.IdleTimeout),
	}
	defer transport.CloseIdleConnections()
	response, err := roundTrip(transport, request, policy.FollowReadRedirects)
	if err != nil {
		return Response{}, err
	}
	defer response.Body.Close()

	return readResponse(response, policy.ReadLimit)
}

// roundTrip передаёт любой ответ 3xx записи вызывающему, даже с некорректным Location.
// Только у чтений с явным разрешением HTTP-клиент разбирает адрес назначения.
func roundTrip(transport *http.Transport, request *http.Request, follow bool) (*http.Response, error) {
	if !follow || request.Method != http.MethodGet && request.Method != http.MethodHead {
		return transport.RoundTrip(request)
	}
	client := &http.Client{
		Transport: transport,
		CheckRedirect: func(next *http.Request, via []*http.Request) error {
			if len(via) > 20 {
				return errors.New("Превышен предел перенаправлений HTTP.")
			}
			if via[0].URL.Scheme != next.URL.Scheme ||
				!strings.EqualFold(originAddress(via[0].URL), originAddress(next.URL)) {
				next.Header.Del("X-Grigdesk-Token")
			}
			return nil
		},
	}
	return client.Do(request)
}

// originAddress уравнивает явный порт с портом по умолчанию той же схемы.
func originAddress(address *url.URL) string {
	port := address.Port()
	if port == "" {
		port = "80"
		if address.Scheme == "https" {
			port = "443"
		}
	}
	return net.JoinHostPort(address.Hostname(), port)
}

// readResponse сохраняет статус и заголовки вместе с исходными байтами тела.
// При ограничении читает один дополнительный байт, чтобы отличить полный ответ от усечённого.
func readResponse(response *http.Response, limit func(int, http.Header) int64) (Response, error) {
	result := Response{Status: response.StatusCode, Header: response.Header}
	var reader io.Reader = response.Body
	maximum := int64(-1)
	if limit != nil {
		maximum = limit(result.Status, result.Header)
	}

	if maximum == 0 {
		return result, nil
	}
	if maximum > 0 {
		reader = io.LimitReader(reader, maximum+1)
	}

	body, err := io.ReadAll(reader)
	if err != nil {
		return Response{}, err
	}
	if maximum > 0 && int64(len(body)) > maximum {
		result.Body = body[:maximum]
		result.Truncated = true
	} else {
		result.Body = body
	}

	return result, nil
}

type idleConn struct {
	net.Conn
	idle time.Duration
}

// dialWithIdleTimeout оставляет соединение живым, пока по нему идут данные.
// Дедлайн контекста независимо ограничивает полный вызов, в том числе установку соединения.
func dialWithIdleTimeout(idle time.Duration) func(context.Context, string, string) (net.Conn, error) {
	dialer := net.Dialer{Timeout: idle}
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := dialer.DialContext(ctx, network, address)
		if err != nil || idle <= 0 {
			return conn, err
		}

		tracked := &idleConn{Conn: conn, idle: idle}
		tracked.touch()
		return tracked, nil
	}
}

func (conn *idleConn) touch() {
	_ = conn.SetDeadline(time.Now().Add(conn.idle))
}

// Read продлевает срок простоя, как только сокет получает данные.
// При EOF и ошибках вызов возвращает исходный результат соединения.
func (conn *idleConn) Read(p []byte) (int, error) {
	read, err := conn.Conn.Read(p)
	if read > 0 {
		conn.touch()
	}
	return read, err
}

// Write делит большую отправку на части, чтобы учитывать прогресс записи.
// Дедлайн продлевается после каждой части, которую принял сокет.
func (conn *idleConn) Write(p []byte) (int, error) {
	const chunkSize = 32 * 1024
	var total int
	for len(p) > 0 {
		size := min(len(p), chunkSize)
		n, err := conn.Conn.Write(p[:size])
		total += n
		if n > 0 {
			conn.touch()
		}
		if err != nil {
			return total, err
		}

		p = p[n:]
	}

	return total, nil
}
