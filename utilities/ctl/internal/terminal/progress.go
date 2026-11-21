package terminal

import (
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"
)

type Progress struct {
	mu        sync.Mutex
	screen    Screen
	file      *os.File
	activity  *activity
	started   time.Time
	drawn     time.Time
	timer     *time.Ticker
	stop      chan struct{}
	open      bool
	label     string
	detail    string
	completed int
	total     int
}

// NewProgress создаёт индикатор только на человеческом терминальном потоке.
// Процент появляется, когда исполнителю известен объём работы.
func NewProgress(out io.Writer, env map[string]string, enabled bool) *Progress {
	if activity, ok := out.(*activity); enabled && ok {
		return &Progress{activity: activity, started: time.Now()}
	}
	file, ok := out.(*os.File)
	if !enabled || !ok || !IsTTY(file) {
		return nil
	}
	progress := &Progress{screen: NewScreen(out, env), file: file, started: time.Now()}
	if progress.screen.positioned {
		progress.timer = time.NewTicker(time.Second)
		progress.stop = make(chan struct{})
		go progress.tick(progress.timer.C)
	}
	return progress
}

// Update обновляет стадию сразу, а счётчики и детали ограничивает по частоте.
// TERM=dumb получает одну строку на стадию и сохраняет читаемый журнал.
func (progress *Progress) Update(label, detail string, completed, total int) {
	if progress == nil {
		return
	}
	progress.mu.Lock()
	defer progress.mu.Unlock()
	changed := progress.label != label
	progress.label, progress.detail = label, detail
	progress.completed, progress.total = completed, total
	if progress.activity != nil {
		progress.activity.setProgress(progress.status())
		return
	}
	if changed || progress.screen.positioned && time.Since(progress.drawn) >= 120*time.Millisecond {
		progress.draw()
	}
}

// Line освобождает строку перед обычным выводом команды.
// Индикатор снова появится при переходе к следующей стадии.
func (progress *Progress) Line() {
	if progress == nil {
		return
	}
	progress.mu.Lock()
	defer progress.mu.Unlock()
	progress.endLine()
}

// Close прекращает перерисовку и восстанавливает обычную строку вывода.
// После окончания можно печатать итог на stdout или stderr.
func (progress *Progress) Close() {
	if progress == nil {
		return
	}
	progress.mu.Lock()
	defer progress.mu.Unlock()
	if progress.timer != nil {
		progress.timer.Stop()
		close(progress.stop)
		progress.timer = nil
	}
	progress.endLine()
}

func (progress *Progress) endLine() {
	if progress.open {
		_, _ = io.WriteString(progress.file, "\r\x1b[K")
		progress.open = false
	}
	progress.label = ""
}

type progressStatus struct {
	label     string
	detail    string
	started   time.Time
	completed int
	total     int
}

func (progress *Progress) status() progressStatus {
	return progressStatus{progress.label, progress.detail, progress.started, progress.completed, progress.total}
}

// tick обновляет время, даже если вложенная команда пока ничего не печатает.
// Блокировка защищает общую строку от одновременных событий параллельной сборки.
func (progress *Progress) tick(ticks <-chan time.Time) {
	for {
		select {
		case <-progress.stop:
			return
		case <-ticks:
			progress.mu.Lock()
			if progress.open {
				progress.draw()
			}
			progress.mu.Unlock()
		}
	}
}

// text использует одну шкалу для строчного вывода и экрана действий.
// Стадия и время видны и тогда, когда объём работы неизвестен.
func (status progressStatus) text(columns int) string {
	bar := "…"
	if status.total > 0 {
		percent := min(100, max(0, int(100*float64(status.completed)/float64(status.total))))
		width := min(12, max(3, columns/6))
		filled := percent * width / 100
		bar = fmt.Sprintf("%s%s %d%%", strings.Repeat("█", filled), strings.Repeat("░", width-filled), percent)
	}
	elapsed := time.Since(status.started).Truncate(time.Second)
	content := fmt.Sprintf("%s  %s · %s", bar, status.label, elapsed)
	if status.detail != "" {
		content += "  › " + status.detail
	}
	return content
}

// draw обновляет индикатор на обычном терминальном потоке.
// Готовая строка вмещается до последнего столбца.
func (progress *Progress) draw() {
	columns, _ := Size(int(progress.file.Fd()))
	content := progress.status().text(columns)
	line := Fit(content, columns)
	if progress.screen.color && columns > 4 {
		line = progress.screen.Label(Fit(content, columns-4), Accent)
	}
	progress.drawn = time.Now()
	progress.open = progress.screen.positioned
	if progress.open {
		_, _ = io.WriteString(progress.file, "\r\x1b[K"+line)
	} else {
		_, _ = io.WriteString(progress.file, line+"\r\n")
	}
}
