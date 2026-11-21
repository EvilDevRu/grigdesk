package tunnel

import (
	"context"
	"encoding/json"
	"time"

	"grigdesk.local/tools/utilities/relay/internal/protocol"
)

type controlMessage struct {
	Type string `json:"t"`
}

// controlLoop отвечает на целые ping/pong и проверяет срок жизни сокета.
// Поколение ожидающих устройств очищается лишь своим владельцем.
func (s *server) controlLoop(ctx context.Context, current *peer, client bool) {
	if err := s.activate(current, client); err != nil {
		s.detach(current)
		return
	}
	defer s.detach(current)
	stop := make(chan struct{})
	defer close(stop)
	go s.ping(ctx, current, stop)
	for {
		_ = current.raw.SetReadDeadline(time.Now().Add(s.config.Dead))
		line, err := protocol.ReadLine(current.input)
		if err != nil {
			return
		}
		var message controlMessage
		if json.Unmarshal(line, &message) != nil || message.Type != "ping" && message.Type != "pong" {
			return
		}
		if message.Type == "ping" && current.write(controlMessage{Type: "pong"}) != nil {
			return
		}
	}
}

// activate привязывает pending к новому control и ставит его ACK первым в потоке записи.
// Предыдущий сокет закрывается без возможности удалить новое поколение.
func (s *server) activate(current *peer, client bool) error {
	current.mu.Lock()
	defer current.mu.Unlock()
	s.mu.Lock()
	if s.control != nil {
		_ = s.control.raw.Close()
	}
	s.control, s.client = current, client
	s.cancelPending()
	s.mu.Unlock()
	_ = current.raw.SetWriteDeadline(time.Now().Add(time.Second))
	defer current.raw.SetWriteDeadline(time.Time{})
	reply := protocol.Reply{OK: true}
	if client {
		reply.Capabilities = []string{"client-v2"}
	}
	if err := protocol.Write(current.conn, reply); err != nil {
		return err
	}
	s.log("control_online", 0)
	return nil
}

// detach снимает только состояние всё ещё действующего control.
// Разрыв вытесненного сокета не освобождает ожидания нового.
func (s *server) detach(control *peer) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.control != control {
		return
	}
	s.control, s.client = nil, false
	s.cancelPending()
	s.log("control_offline", 0)
}

// ping периодически проверяет контрольный канал до завершения worker или control.
// Ошибка отправки будит reader закрытием принадлежащего ему сокета.
func (s *server) ping(ctx context.Context, control *peer, stop <-chan struct{}) {
	timer := time.NewTicker(s.config.Ping)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-stop:
			return
		case <-timer.C:
			if err := control.write(controlMessage{Type: "ping"}); err != nil {
				_ = control.raw.Close()
				return
			}
		}
	}
}
