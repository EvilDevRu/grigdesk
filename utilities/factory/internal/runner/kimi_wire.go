package runner

import (
	"bytes"
	"encoding/json"
	"io"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type kimiWire struct {
	target       io.Writer
	home         string
	lock         sync.Mutex
	partial      []byte
	offsets      map[string]int
	delegations  map[string]bool
	stop, closed chan struct{}
}

func startKimiWire(target io.Writer, home string) *kimiWire {
	wire := &kimiWire{
		target: target, home: home, offsets: make(map[string]int), delegations: make(map[string]bool),
		stop: make(chan struct{}), closed: make(chan struct{}),
	}
	go func() {
		defer close(wire.closed)
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				wire.scan()
			case <-wire.stop:
				return
			}
		}
	}()
	return wire
}

// Write переносит полные строки CLI байт в байт под общим lock с обогащением.
// Частичная строка завершается перед финальной выборкой из wire.
func (w *kimiWire) Write(data []byte) (int, error) {
	w.lock.Lock()
	defer w.lock.Unlock()
	w.partial = append(w.partial, data...)
	if cut := bytes.LastIndexByte(w.partial, '\n'); cut >= 0 {
		if _, err := w.target.Write(w.partial[:cut+1]); err != nil {
			return 0, err
		}
		w.partial = slicesTail(w.partial, cut+1)
	}
	return len(data), nil
}

func (w *kimiWire) close() {
	close(w.stop)
	<-w.closed
	w.scan()
	w.lock.Lock()
	defer w.lock.Unlock()
	if len(w.partial) > 0 {
		_, _ = w.target.Write(w.partial)
	}
}

func slicesTail(raw []byte, index int) []byte {
	return append(raw[:0], raw[index:]...)
}

func (w *kimiWire) scan() {
	paths, err := filepath.Glob(filepath.Join(w.home, "sessions", "*", "*", "agents", "*", "wire.jsonl"))
	if err != nil {
		return
	}
	w.lock.Lock()
	defer w.lock.Unlock()
	for _, path := range paths {
		agentDir := filepath.Dir(path)
		physical, err := filepath.EvalSymlinks(agentDir)
		if err != nil || physical != agentDir {
			continue
		}
		raw := readRunLog(agentDir, "wire.jsonl", 32*1024*1024)
		count := w.offsets[path]
		if count > len(raw) {
			count = 0
		}
		chunk := raw[count:]
		cut := bytes.LastIndexByte(chunk, '\n')
		if cut < 0 {
			continue
		}
		w.offsets[path] = count + cut + 1
		agent := filepath.Base(agentDir)
		for _, line := range bytes.Split(chunk[:cut+1], []byte{'\n'}) {
			w.emit(agent, line)
		}
	}
}

func (w *kimiWire) emit(agent string, raw []byte) {
	var row struct {
		Type  string         `json:"type"`
		Event map[string]any `json:"event"`
	}
	if json.Unmarshal(raw, &row) != nil || row.Type != "context.append_loop_event" {
		return
	}
	event := row.Event
	id, _ := event["toolCallId"].(string)
	payload := map[string]any{"agent": agent, "bridge": "kimi-wire", "role": "assistant"}
	switch event["type"] {
	case "tool.call":
		if agent == "main" {
			if event["name"] != "Agent" || w.delegations[id] {
				return
			}
			w.delegations[id] = true
		}
		call := map[string]any{"type": "function", "id": id, "function": map[string]any{
			"name": event["name"], "arguments": kimiPreview(event["args"]),
		}}
		payload["tool_calls"] = []any{call}
	case "tool.result":
		if agent == "main" && !w.delegations[id] {
			return
		}
		payload["role"], payload["tool_call_id"] = "tool", id
		payload["content"] = kimiPreview(event["result"])
	case "content.part":
		if agent == "main" {
			return
		}
		part, _ := event["part"].(map[string]any)
		kind, _ := part["type"].(string)
		pre := kimiPreview(part[kind])
		if pre == "" {
			return
		}
		field := "content"
		if kind == "think" {
			field = "thinking"
		}
		payload[field] = pre
	default:
		return
	}
	encoded, err := json.Marshal(payload)
	if err == nil {
		_, _ = w.target.Write(append(encoded, '\n'))
	}
}

func kimiPreview(value any) string {
	if value == nil {
		return ""
	}
	text, ok := value.(string)
	if !ok {
		raw, _ := json.Marshal(value)
		text = string(raw)
	}
	runes := []rune(strings.ToValidUTF8(text, "�"))
	if len(runes) > 2000 {
		return string(runes[:2000]) + "…"
	}
	return string(runes)
}
