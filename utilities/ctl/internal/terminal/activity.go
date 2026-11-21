package terminal

import (
	"context"
	"io"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/term"
)

const (
	maxOutputLines = 200
	maxOutputLine  = 4096
)

type ActivityLabels struct {
	Title      string
	Running    string
	Stopping   string
	Cancelled  string
	Done       string
	Failed     string
	Cancel     string
	Navigation string
}

type activity struct {
	mu       sync.Mutex
	lines    []string
	pending  string
	rewrite  bool
	progress progressStatus
	revision uint64
}

// Write собирает ограниченный хвост вывода дочерних процессов для экрана результата.
// CR заменяет текущую строку индикатора, LF добавляет её к обычному выводу.
func (work *activity) Write(data []byte) (int, error) {
	work.mu.Lock()
	defer work.mu.Unlock()

	remaining := string(data)
	for {
		at := strings.IndexAny(remaining, "\r\n")
		if at < 0 {
			work.appendPending(remaining)
			break
		}
		work.appendPending(remaining[:at])
		if remaining[at] == '\n' {
			work.lines = append(work.lines, work.pending)
			work.pending = ""
		}
		work.rewrite = remaining[at] == '\r'
		remaining = remaining[at+1:]
	}
	if excess := len(work.lines) - maxOutputLines; excess > 0 {
		copy(work.lines, work.lines[excess:])
		clear(work.lines[maxOutputLines:])
		work.lines = work.lines[:maxOutputLines]
	}
	work.revision++
	return len(data), nil
}

func (work *activity) appendPending(part string) {
	if part == "" {
		return
	}
	if work.rewrite {
		work.pending = ""
		work.rewrite = false
	}
	if len(part) >= maxOutputLine {
		work.pending = part[len(part)-maxOutputLine:]
		return
	}
	work.pending += part
	if len(work.pending) > maxOutputLine {
		work.pending = work.pending[len(work.pending)-maxOutputLine:]
	}
}

func (work *activity) setProgress(status progressStatus) {
	work.mu.Lock()
	defer work.mu.Unlock()
	work.progress = status
	work.revision++
}

// RunActivity меняет содержимое уже открытого экрана, сохраняя его владельца.
// Результат можно просмотреть и закрыть отдельно от всего меню.
func (screen *Screen) RunActivity(
	input Input, labels ActivityLabels, run func(context.Context, io.Writer) int,
) error {
	work := &activity{}
	code, err := screen.waitActivity(input, labels, work, run)
	if err != nil {
		return err
	}
	if code == 130 {
		labels.Done = labels.Cancelled
	} else if code != 0 {
		labels.Done = strings.ReplaceAll(labels.Failed, "{code}", strconv.Itoa(code))
	}
	_, err = input.Select(Selection{
		Page: math.MaxInt,
		Draw: func(columns, rows, _, page int) int {
			return screen.drawActivity(work, labels, columns, rows, page, code, false, false)
		},
	})
	return err
}

// waitActivity читает Ctrl+C в raw-режиме и отменяет только выполняемую команду.
// Сигнал всему CLI и закрытый ввод завершают сеанс после уборки дочерней команды.
func (screen *Screen) waitActivity(input Input, labels ActivityLabels, work *activity,
	run func(context.Context, io.Writer) int) (int, error) {
	restore, err := term.MakeRaw(input.FD)
	if err != nil {
		return 2, Exit(2)
	}
	defer term.Restore(input.FD, restore)

	ctx, stop := context.WithCancel(input.Ctx)
	defer stop()
	finished := make(chan int, 1)
	go func() { finished <- run(ctx, work) }()

	var oldColumns, oldRows int
	var oldRevision uint64
	var redrawn time.Time
	for {
		select {
		case code := <-finished:
			if input.Ctx.Err() != nil {
				return code, Exit(130)
			}
			if ctx.Err() != nil {
				return 130, nil
			}
			return code, nil
		default:
		}
		columns, rows := Size(input.FD)
		work.mu.Lock()
		revision := work.revision
		work.mu.Unlock()
		resized := columns != oldColumns || rows != oldRows
		if resized || revision != oldRevision || time.Since(redrawn) >= time.Second {
			screen.drawActivity(work, labels, columns, rows, math.MaxInt, 0, true, ctx.Err() != nil)
			redrawn = time.Now()
			oldColumns, oldRows, oldRevision = columns, rows, revision
		}
		_, _, err := input.Read(100)
		if err != nil {
			stop()
			if err != Exit(130) || input.Ctx.Err() != nil {
				return <-finished, err
			}
			redrawn = time.Time{}
		}
	}
}

// drawActivity держит заголовок, состояние и подсказку на экране, даже если вывод длиннее окна.
// При завершении подробности можно листать, а во время команды виден свежий вывод.
func (screen *Screen) drawActivity(work *activity, labels ActivityLabels, columns, rows, page, code int,
	running, stopping bool) int {
	columns = min(columns, 100)
	inset := Inset(columns)
	content := columns - len(inset)*2
	work.mu.Lock()
	output := append([]string(nil), work.lines...)
	if work.pending != "" {
		output = append(output, work.pending)
	}
	progress := work.progress
	work.mu.Unlock()

	status, tone, navigation := labels.Done, Success, labels.Navigation
	switch {
	case stopping:
		status, tone, navigation = labels.Stopping, Warning, ""
	case running:
		status, tone, navigation = labels.Running, Accent, labels.Cancel
		if progress.label != "" {
			status = progress.text(content)
		}
	case code == 130:
		tone = Warning
	case code != 0:
		tone = Error
	}
	if rows <= 1 {
		screen.Draw([]Row{Line(status, tone)}, columns, rows)
		return 0
	}
	lines := []Row{Line(inset+labels.Title, Accent), Line(inset+status, tone)}
	if rows <= 3 {
		screen.Draw(lines, columns, rows)
		return 0
	}
	if rows >= 6 {
		lines = append(lines, Line(inset+strings.Repeat("─", content), Rule))
	}

	var detail []Row
	for _, line := range output {
		for _, segment := range Wrap(line, content) {
			detail = append(detail, Line(inset+segment, Text))
		}
	}
	visible := rows - len(lines) - 2
	if len(detail) > 0 {
		last := (len(detail) - 1) / visible
		page = min(page, last)
		from := page * visible
		if page == last {
			from = max(0, len(detail)-visible)
		}
		lines = append(lines, detail[from:min(from+visible, len(detail))]...)
	} else {
		page = 0
	}
	lines = append(lines, Line(inset+navigation, Muted))
	screen.Draw(lines, columns, rows)
	return page
}
