package tunnel

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"regexp"
	"strconv"
	"time"

	"grigdesk.local/tools/utilities/relay/internal/protocol"
)

var healthPort = regexp.MustCompile(`^[1-9][0-9]{0,4}$`)

// Health проверяет строго loopback TLS и одну bounded строку health.
// Самоподписанный сертификат допускается только в этой локальной проверке готовности.
func Health(ctx context.Context, env map[string]string) error {
	value, exists := env["RELAY_PORT"]
	if !exists {
		value = "7443"
	}
	port, _ := strconv.Atoi(value)
	if !healthPort.MatchString(value) || port > 65535 {
		return fmt.Errorf("Некорректный порт проверки relay")
	}
	bounded, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	dialer := &tls.Dialer{Config: &tls.Config{MinVersion: tls.VersionTLS13, InsecureSkipVerify: true}}
	conn, err := dialer.DialContext(bounded, "tcp4", net.JoinHostPort("127.0.0.1", value))
	if err != nil {
		return err
	}
	defer conn.Close()
	deadline, _ := bounded.Deadline()
	_ = conn.SetDeadline(deadline)
	if _, err := io.WriteString(conn, "{\"v\":1,\"role\":\"health\"}\n"); err != nil {
		return err
	}
	reader := bufio.NewReaderSize(conn, protocol.Maximum+1)
	line, err := protocol.ReadLine(reader)
	if err != nil {
		return err
	}
	var reply protocol.Reply
	if json.Unmarshal(line, &reply) != nil || !reply.OK || reader.Buffered() != 0 {
		return fmt.Errorf("Relay не подтвердил health")
	}
	return nil
}
