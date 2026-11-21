package tunnel

import (
	"net"
	"time"
)

type limitEntry struct {
	active   int
	failures int
	window   time.Time
	until    time.Time
}

// sweepLoop освобождает неиспользуемые записи даже когда нет новых подключений.
// Таймер завершается вместе с обслуживающим процессом.
func (s *server) sweepLoop(done <-chan struct{}) {
	timer := time.NewTicker(min(s.config.BanWindow, time.Minute))
	defer timer.Stop()
	for {
		select {
		case now := <-timer.C:
			s.mu.Lock()
			s.sweep(now)
			s.mu.Unlock()
		case <-done:
			return
		}
	}
}

// acquire резервирует общий слот и слот адреса до TLS handshake.
// Заполненная таблица не вытесняет активную запись или запрет.
func (s *server) acquire(connection net.Conn) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.sockets) >= s.config.MaxConnect {
		return false
	}
	ip, _, err := net.SplitHostPort(connection.RemoteAddr().String())
	if err != nil {
		ip = "unknown"
	}
	entry := s.limits[ip]
	if entry == nil {
		if len(s.limits) >= 4096 {
			s.sweep(time.Now())
		}
		if len(s.limits) >= 4096 {
			return false
		}
		entry = &limitEntry{window: time.Now()}
		s.limits[ip] = entry
	}
	if entry.active >= s.config.MaxPerIP {
		return false
	}
	entry.active++
	s.sockets[connection] = ip
	return true
}

// release снимает слот один раз и очищает записи с окончившимся сроком.
// Адрес извлекается из состояния исходного TCP accept, а не из данных hello.
func (s *server) release(connection net.Conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ip, exists := s.sockets[connection]; exists {
		s.limits[ip].active--
		delete(s.sockets, connection)
	}
	s.sweep(time.Now())
}

// sweep сохраняет адреса с открытым соединением или ещё действующей причиной запрета.
// Бюджет адресов ограничен даже при постоянном потоке новых клиентов.
func (s *server) sweep(now time.Time) {
	for ip, entry := range s.limits {
		if now.Sub(entry.window) >= s.config.BanWindow && !now.Before(entry.until) {
			entry.failures = 0
			entry.until = time.Time{}
			entry.window = now
		}
		if entry.active == 0 && entry.failures == 0 && entry.until.IsZero() {
			delete(s.limits, ip)
		}
	}
}

func (s *server) banned(connection net.Conn) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry := s.limits[s.sockets[connection]]
	return entry != nil && time.Now().Before(entry.until)
}

// failure обновляет окно аутентификации конкретного IP без журналирования адреса.
// Истёкший бан может смениться новым только после очередного отказа.
func (s *server) failure(connection net.Conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry := s.limits[s.sockets[connection]]
	if entry == nil {
		return
	}
	now := time.Now()
	if now.Sub(entry.window) >= s.config.BanWindow {
		entry.window, entry.failures = now, 0
	}
	entry.failures++
	if entry.failures >= s.config.BanThreshold {
		entry.until = now.Add(s.config.BanWindow)
	}
}
