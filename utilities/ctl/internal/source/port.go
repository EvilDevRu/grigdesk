package source

import (
	"context"
	"net"
	"time"
)

func PortOpen(ctx context.Context, port string) bool {
	probe := &net.Dialer{Timeout: time.Second}
	connection, err := probe.DialContext(ctx, "tcp", net.JoinHostPort("127.0.0.1", port))
	if err != nil {
		return false
	}
	_ = connection.Close()
	return true
}
