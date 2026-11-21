package terminal

import (
	"context"
	"errors"
	"io"
	"math"
	"unicode/utf8"

	"golang.org/x/sys/unix"
	"golang.org/x/term"
)

type Input struct {
	Ctx context.Context
	FD  int
	Out io.Writer
}

type Exit int

const EndOfInput Exit = 0

func (e Exit) Error() string {
	return "Ввод закрыт."
}

// Read ждёт один байт и различает таймаут, закрытие ввода и отмену.
// Обычные клавиши не интерпретируются до уровня конкретного поля или списка.
func (input Input) Read(milliseconds int) (byte, bool, error) {
	for input.Ctx.Err() == nil {
		poll := []unix.PollFd{{Fd: int32(input.FD), Events: unix.POLLIN}}
		ready, err := unix.Poll(poll, milliseconds)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return 0, false, Exit(2)
		}
		if ready == 0 {
			return 0, false, nil
		}
		var buffer [1]byte
		n, err := unix.Read(input.FD, buffer[:])
		if err != nil {
			return 0, false, Exit(2)
		}
		if n == 0 || buffer[0] == 4 {
			return 0, false, EndOfInput
		}
		if buffer[0] == 3 {
			return 0, false, Exit(130)
		}
		return buffer[0], true, nil
	}
	return 0, false, Exit(130)
}

// Byte ждёт ввод до закрытия или отмены контекста.
// Короткие проверки позволяют быстро обработать сигнал без новой клавиши.
func (input Input) Byte() (byte, error) {
	for {
		value, ok, err := input.Read(100)
		if err != nil || ok {
			return value, err
		}
	}
}

// Text читает одну строку в raw-режиме, включая вставку и Backspace по символам.
// Секретный ввод не записывается в терминал, а временный буфер очищается.
func (input Input) Text(label string, secret bool, initial []byte, limit int) (string, error) {
	restore, err := term.MakeRaw(input.FD)
	if err != nil {
		return "", Exit(2)
	}
	defer term.Restore(input.FD, restore)
	_, _ = io.WriteString(input.Out, label)

	value := make([]byte, 0, limit)
	defer func() { clear(value[:cap(value)]) }()
	value = append(value, initial...)
	for {
		key, err := input.Byte()
		if err != nil {
			return "", err
		}
		switch key {
		case '\r', '\n':
			_, _ = io.WriteString(input.Out, "\r\n")
			return string(value), nil
		case 27:
			_, _ = io.WriteString(input.Out, "\r\n")
			return "", Exit(2)
		case 8, 127:
			if len(value) != 0 {
				r, size := utf8.DecodeLastRune(value)
				value = value[:len(value)-size]
				if !secret {
					_, _ = io.WriteString(input.Out, "\b \b")
					if cellWidth(r) == 2 {
						_, _ = io.WriteString(input.Out, "\b \b")
					}
				}
			}
		default:
			if key >= 32 && len(value) < limit {
				value = append(value, key)
				if !secret {
					_, _ = input.Out.Write([]byte{key})
				}
			}
		}
	}
}

type Selection struct {
	Count    int
	Current  int
	Page     int
	Draw     func(columns, rows, selected, page int) int
	Shortcut func(byte) (int, error)
}

// Select сохраняет термиос, ведёт один активный пункт и перерисовывает при resize.
// Дополнительный ввод используется для совместимости текстовых сценариев мастера.
func (input Input) Select(choice Selection) (int, error) {
	restore, err := term.MakeRaw(input.FD)
	if err != nil {
		return -1, Exit(2)
	}
	defer term.Restore(input.FD, restore)

	columns, rows := Size(input.FD)
	selected, page := choice.Current, choice.Page
	page = choice.Draw(columns, rows, selected, page)
	for {
		key, ready, err := input.Read(100)
		if err != nil {
			return -1, err
		}
		before, beforePage := selected, page
		if ready {
			move, err := input.selectionKey(key, choice.Shortcut)
			if err != nil {
				return -1, err
			}
			switch move {
			case up:
				if choice.Count == 0 {
					page = max(0, page-1)
				} else {
					selected = (selected + choice.Count - 1) % choice.Count
				}
			case down:
				if choice.Count == 0 {
					page++
				} else {
					selected = (selected + 1) % choice.Count
				}
			case pageUp:
				page = max(0, page-1)
			case pageDown:
				page++
			case firstPage:
				page = 0
			case lastPage:
				page = math.MaxInt
			case enter:
				return selected, nil
			case ignore:
			default:
				return int(move), nil
			}
		}
		nextColumns, nextRows := Size(input.FD)
		if before != selected || beforePage != page || columns != nextColumns || rows != nextRows {
			columns, rows = nextColumns, nextRows
			page = choice.Draw(columns, rows, selected, page)
		}
	}
}

type movement int

const (
	ignore movement = -1 - iota
	up
	down
	enter
	pageUp
	pageDown
	firstPage
	lastPage
)

// selectionKey понимает стрелки в обычном и application-режиме терминала.
// Esc закрывает выбор, а последовательности PageUp/PageDown перелистывают подробности.
func (input Input) selectionKey(key byte, shortcut func(byte) (int, error)) (movement, error) {
	switch key {
	case '\r', '\n':
		return enter, nil
	case '\t':
		return down, nil
	case 27:
		prefix, ok, err := input.Read(35)
		if err != nil {
			return ignore, err
		}
		if !ok || prefix != '[' && prefix != 'O' {
			return ignore, Exit(2)
		}
		tail, _, err := input.Read(35)
		if err != nil {
			return ignore, err
		}
		switch tail {
		case 'A':
			return up, nil
		case 'B':
			return down, nil
		case 'H':
			return firstPage, nil
		case 'F':
			return lastPage, nil
		case '5', '6':
			end, _, err := input.Read(35)
			if end == '~' && tail == '5' {
				return pageUp, err
			}
			if end == '~' {
				return pageDown, err
			}
		}
		return ignore, nil
	}
	if shortcut != nil && key >= 32 {
		index, err := shortcut(key)
		return movement(index), err
	}
	switch key {
	case 'k':
		return up, nil
	case 'j':
		return down, nil
	case 'q':
		return ignore, Exit(2)
	}
	return ignore, nil
}
