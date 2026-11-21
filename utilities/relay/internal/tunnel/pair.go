package tunnel

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"net"
	"time"

	"grigdesk.local/tools/utilities/relay/internal/protocol"
)

type pending struct {
	device *peer
	target string
	ref    string
	assign chan assignment
	done   chan struct{}
}

type assignment struct {
	brain *peer
	code  string
}

type notice struct {
	Type   string `json:"t"`
	ID     string `json:"id"`
	Target string `json:"target,omitempty"`
}

// waitDevice регистрирует одно ожидание, пока устройство не подало ранний байт и не закрыло сокет.
// Поток передачи начинается лишь после назначения brain-data с тем же id и target.
func (s *server) waitDevice(device *peer, target string) {
	_ = device.raw.SetReadDeadline(time.Now().Add(s.config.BrainTimeout))
	entry, control, code := s.reserve(device, target)
	if entry == nil {
		device.fail(code)
		return
	}
	defer close(entry.done)
	incoming := notice{Type: "incoming", ID: entry.ref, Target: target}
	if err := control.write(incoming); err != nil {
		_ = control.raw.Close()
	}
	_, err := device.input.Peek(1)
	if s.remove(entry) {
		switch {
		case err == nil:
			device.fail("bad_hello")
		case timedOut(err):
			device.fail("brain_timeout")
		}
		return
	}
	result := <-entry.assign
	if result.code != "" {
		device.fail(result.code)
		return
	}
	s.bridge(device, result.brain)
}

// reserve подвешивает устройство на текущем control в пределах общего бюджета.
// Поддержка client-v2 проверяется на том же поколении, что и регистрация id.
func (s *server) reserve(device *peer, target string) (*pending, *peer, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.control == nil {
		return nil, nil, "brain_offline"
	}
	if target == "client" && !s.client {
		return nil, nil, "client_unavailable"
	}
	if len(s.pending) >= s.config.MaxPending {
		return nil, nil, "busy"
	}
	var random [16]byte
	_, _ = rand.Read(random[:])
	entry := &pending{
		device: device,
		target: target,
		ref:    hex.EncodeToString(random[:]),
		assign: make(chan assignment, 1),
		done:   make(chan struct{}),
	}
	s.pending[entry.ref] = entry
	return entry, s.control, ""
}

// remove снимает только то ожидание, которое было выдано этому устройству.
// Отсутствие записи означает, что отдельное решение уже записано в assign.
func (s *server) remove(entry *pending) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pending[entry.ref] != entry {
		return false
	}
	delete(s.pending, entry.ref)
	return true
}

// dataPeer отмечает brain-data занятым до полного закрытия уже склеенной пары.
// Ошибочный target не расходует ожидающее устройство и сохраняет исходный id.
func (s *server) dataPeer(ctx context.Context, brain *peer, id, target string) {
	entry, reason := s.take(brain, id, target)
	if entry == nil {
		brain.fail(reason)
		return
	}
	select {
	case <-entry.done:
	case <-ctx.Done():
	}
}

// take применяет результат только к ещё ожидающему id.
// Выставленный дедлайн прерывает Peek у устройства и передаёт владение потоком.
func (s *server) take(brain *peer, id, target string) (*pending, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if target == "client" {
		if s.control == nil {
			return nil, "brain_offline"
		}
		if !s.client {
			return nil, "client_unavailable"
		}
	}
	entry := s.pending[id]
	if entry == nil || entry.target != target {
		return nil, "unknown_id"
	}
	delete(s.pending, id)
	entry.assign <- assignment{brain: brain}
	_ = entry.device.raw.SetReadDeadline(time.Now())
	return entry, ""
}

// cancelPending вызывается только с захваченным s.mu при смене или закрытии control.
// Подвешенный Peek разблокируется после передачи окончательного кода.
func (s *server) cancelPending() {
	for id, entry := range s.pending {
		delete(s.pending, id)
		entry.assign <- assignment{code: "brain_offline"}
		_ = entry.device.raw.SetReadDeadline(time.Now())
	}
}

// bridge выдаёт оба ACK до копирования бинарного хвоста.
// Завершение любого направления закрывает оба сокета и дожидается второго потока.
func (s *server) bridge(device, brain *peer) {
	_ = device.raw.SetDeadline(time.Time{})
	_ = brain.raw.SetDeadline(time.Time{})
	if brain.write(protocol.Reply{OK: true}) != nil || device.write(protocol.Reply{OK: true}) != nil {
		_ = device.raw.Close()
		_ = brain.raw.Close()
		return
	}
	d := flow{peer: device, idle: s.config.Idle}
	b := flow{peer: brain, idle: s.config.Idle}
	d.touch()
	b.touch()
	s.log("paired", 0)
	end := make(chan struct{}, 2)
	go copyFlow(d, b, end)
	go copyFlow(b, d, end)
	<-end
	_ = device.raw.Close()
	_ = brain.raw.Close()
	<-end
}

func copyFlow(dest, src flow, done chan<- struct{}) {
	_, _ = io.Copy(dest, src)
	done <- struct{}{}
}

type flow struct {
	peer *peer
	idle time.Duration
}

func (f flow) touch() {
	_ = f.peer.raw.SetDeadline(time.Now().Add(f.idle))
}

// Read использует сохранённый reader, чтобы байты уже принятого TLS не потерялись.
// Дедлайн idle продлевается только при фактическом обмене.
func (f flow) Read(data []byte) (int, error) {
	n, err := f.peer.input.Read(data)
	if n > 0 {
		f.touch()
	}
	return n, err
}

// Write пересылает полученные байты с обратным давлением на отправителя.
// Слот потока сохраняется до ошибки, закрытия или фактического срока простоя.
func (f flow) Write(data []byte) (int, error) {
	n, err := f.peer.conn.Write(data)
	if n > 0 {
		f.touch()
	}
	return n, err
}

func timedOut(err error) bool {
	timeout, ok := err.(net.Error)
	return ok && timeout.Timeout()
}
