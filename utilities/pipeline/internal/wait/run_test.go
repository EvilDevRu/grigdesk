package wait

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"grigdesk.local/tools/utilities/pipeline/internal/control"
)

var fixtureAttempt = "a_" + strings.Repeat("a", 32)

func cursor(terminal any) map[string]any {
	return map[string]any{
		"profile":       "demo",
		"attempt":       fixtureAttempt,
		"node":          "build",
		"state":         "ready",
		"stop":          nil,
		"sequence":      float64(8),
		"headEventHash": strings.Repeat("b", 64),
		"orchPid":       float64(0),
		"terminal":      terminal,
	}
}

// TestObserveWait проверяет обе authority, смену фазы, hold и устаревшую попытку.
// Инъекция часов подтверждает отсутствие ложного terminal без тайминговой гонки.
func TestObserveWait(t *testing.T) {
	scenarios := []string{"terminal", "race", "human", "stopped", "timeout", "replaced", "readOnly"}
	for _, scenario := range scenarios {
		t.Run(scenario, func(t *testing.T) {
			now := time.Now()
			slept := 0
			source := func(_ context.Context, path string) (any, error) {
				return observationFixture(scenario, slept, path), nil
			}
			clock := Clock{
				Now: func() time.Time { return now },
				Sleep: func(_ context.Context, delay time.Duration) error {
					now = now.Add(delay)
					slept++
					return nil
				},
			}
			target := Target{
				Task:     "7",
				Attempt:  fixtureAttempt,
				Timeout:  time.Second,
				Interval: 500 * time.Millisecond,
			}
			result, err := Run(t.Context(), target, source, clock)
			checkObservation(t, scenario, result, err, slept)
		})
	}
}

// observationFixture имитирует последовательные снимки одной из фаз без настоящего профиля.
// В сценарии гонки старое detail перестаёт быть допустимым при null prelude.
func observationFixture(scenario string, slept int, path string) map[string]any {
	attempt := fixtureAttempt
	if scenario == "replaced" {
		attempt = "a_" + strings.Repeat("c", 32)
	}
	if strings.HasSuffix(path, "/mobile-state") {
		if scenario == "race" && slept > 0 {
			return map[string]any{"identity": cursor("completed"), "running": false}
		}
		if scenario == "stopped" || scenario == "timeout" {
			return map[string]any{"identity": cursor(nil), "running": false}
		}
		return map[string]any{"identity": nil, "running": false}
	}
	if strings.HasSuffix(path, "/prelude-state") {
		var terminal any = "abandoned"
		var identity any
		if scenario == "race" || scenario == "human" {
			terminal = nil
		}
		if scenario == "human" {
			identity = map[string]any{"profile": "demo", "attempt": attempt, "bootstrap": nil}
		}
		return map[string]any{
			"identity": identity, "attempt": attempt, "profile": "demo", "running": false, "terminal": terminal,
		}
	}
	result := map[string]any{
		"attempt": attempt, "profile": "demo", "daemonAlive": false, "readOnly": scenario == "readOnly",
		"registry": map[string]any{"RESULT": "completed"},
	}
	if scenario == "human" {
		result["bootstrapStop"] = map[string]any{"state": "waiting", "visitId": "b_" + strings.Repeat("b", 32)}
	}
	if scenario == "race" {
		result["stall"] = map[string]any{"kind": "human", "reason": "Старый снимок"}
	}
	if scenario == "stopped" {
		result["registry"] = map[string]any{"HELD_START": "1"}
	}
	return result
}

// checkObservation связывает исход и код с конкретной попыткой исходного вызова.
// Для гонки требуется реальный переход к следующему наблюдению по тестовым часам.
func checkObservation(t *testing.T, scenario string, result Result, err error, slept int) {
	t.Helper()
	if scenario == "replaced" || scenario == "readOnly" {
		var failure *control.Failure
		if !errors.As(err, &failure) || failure.Code != 22 {
			t.Fatalf("ошибка = %v", err)
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	if scenario == "timeout" {
		expected := outcome{Outcome: "timeout", Task: "7", Attempt: fixtureAttempt}
		if result.Code != 124 || result.Output != expected || slept != 2 {
			t.Fatalf("получено %+v, пауз %d", result, slept)
		}
		return
	}
	expected := scenario
	if scenario == "race" {
		expected = "terminal"
	}
	observed, ok := result.Output.(observedOutcome)
	if !ok || observed.Outcome != expected || observed.Attempt != fixtureAttempt || result.Code != 0 {
		t.Fatalf("получено %+v, ожидали %s", result, expected)
	}
	if scenario == "race" && (slept != 1 || observed.Terminal != "completed") ||
		scenario == "terminal" && (slept != 0 || observed.Terminal != "abandoned" || observed.Identity != nil) {
		t.Fatalf("получено %+v, пауз %d", result, slept)
	}
}
