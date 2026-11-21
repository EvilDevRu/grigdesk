package wait

import (
	"context"
	"errors"
	"grigdesk.local/tools/utilities/pipeline/internal/control"
	"time"
)

type Clock struct {
	Now   func() time.Time
	Sleep func(context.Context, time.Duration) error
}

type Target struct {
	Task     string
	Attempt  string
	Timeout  time.Duration
	Interval time.Duration
}

type Result struct {
	Output any
	Code   int
}

type outcome struct {
	Outcome string `json:"outcome"`
	Task    string `json:"task"`
	Attempt string `json:"attempt"`
}

type observedOutcome struct {
	outcome
	Terminal any `json:"terminal,omitzero"`
	Identity any `json:"identity"`
	Reason   any `json:"reason,omitzero"`
}

// Run ждёт одну попытку под общим монотонным дедлайном для HTTP и пауз.
// При истечении срока оставляет структурированный результат, при сигнале возвращает причину отмены.
func Run(ctx context.Context, target Target, read Reader, clock Clock) (Result, error) {
	if clock.Now == nil {
		clock.Now = time.Now
	}
	if clock.Sleep == nil {
		clock.Sleep = sleep
	}
	deadline := clock.Now().Add(target.Timeout)
	bounded, cancel := context.WithTimeout(ctx, target.Timeout)
	defer cancel()
	for clock.Now().Before(deadline) {
		snapshot, err := observe(bounded, target.Task, read)
		if err == nil {
			result, done, err := decide(target, snapshot)
			if done || err != nil {
				return result, err
			}
			remaining := deadline.Sub(clock.Now())
			if remaining <= 0 {
				break
			}
			err = clock.Sleep(bounded, min(remaining, target.Interval))
		}
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
				break
			}
			return Result{}, err
		}
	}
	output := outcome{Outcome: "timeout", Task: target.Task, Attempt: target.Attempt}
	return Result{Output: output, Code: 124}, nil
}

// decide проверяет принадлежность и пригодность наблюдения до классификации исхода.
// Флаг terminal приходит из authority, состояние registry не становится terminal.
func decide(target Target, sample observation) (Result, bool, error) {
	if sample.detail["readOnly"] == true {
		return Result{}, false, failed("Историческая попытка недоступна для exact ожидания.")
	}
	attempt := sample.attempt
	if value, ok := sample.identity["attempt"].(string); ok {
		attempt = value
	}
	if attempt != target.Attempt {
		return Result{}, false, failed("Попытка изменилась или её identity недоступна.")
	}
	result := observedOutcome{outcome: outcome{Task: target.Task, Attempt: target.Attempt}}
	if sample.identity != nil {
		result.Identity = sample.identity
	}
	terminal := sample.identity["terminal"]
	if terminal == nil {
		terminal = sample.terminal
	}
	if terminal != nil && (sample.identity != nil || sample.stable) {
		result.Outcome = "terminal"
		result.Terminal = terminal
		return Result{Output: result}, true, nil
	}
	if !stopped(target, sample) {
		return Result{}, false, nil
	}
	return decideStopped(sample, result)
}

// stopped признаёт только стабильный снимок без DAEMON и с тем же профилем.
// Чужой detail или неявный readOnly не участвует в выборе исхода.
func stopped(target Target, sample observation) bool {
	profile, _ := sample.identity["profile"].(string)
	return sample.stable && !sample.running && sample.detail != nil && sample.detail["daemonAlive"] == false &&
		sample.detail["attempt"] == target.Attempt && sample.detail["readOnly"] == false &&
		(sample.identity == nil || sample.detail["profile"] == profile)
}

// decideStopped различает остановку человеком и штатный hold перед первым запуском.
// Готовая попытка без подтверждённого события продолжает ожидание.
func decideStopped(sample observation, result observedOutcome) (Result, bool, error) {
	var bootstrap any
	if value := sample.detail["bootstrapStop"]; value != nil && value != false {
		row, err := record(value)
		if err != nil {
			return Result{}, false, err
		}
		bootstrap = row
	}
	state, _ := sample.identity["state"].(string)
	stop := sample.identity["stop"]
	stall := sample.detail["stall"]
	if row, ok := bootstrap.(control.Record); ok && row["state"] == "waiting" ||
		state == "paused" || stop != nil || stall != nil {
		result.Outcome = "human"
		result.Reason = firstValue(bootstrap, stall, stop, state)
		return Result{Output: result}, true, nil
	}
	registry, err := record(sample.detail["registry"])
	if err != nil {
		return Result{}, false, err
	}
	if registry["STOPPED_SIGNAL"] == "1" || registry["HELD_START"] == "1" {
		result.Outcome = "stopped"
		return Result{Output: result}, true, nil
	}
	return Result{}, false, nil
}

func firstValue(values ...any) any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

// sleep отдаёт управление до следующего чтения или отмены клиента.
// Остановленный таймер больше не удерживает ресурсы ожидания.
func sleep(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return context.Cause(ctx)
	case <-timer.C:
		return nil
	}
}
