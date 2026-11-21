package wait

import (
	"context"
	"reflect"

	"grigdesk.local/tools/utilities/pipeline/internal/control"
)

type Reader func(context.Context, string) (any, error)

type observation struct {
	identity control.Record
	detail   control.Record
	attempt  string
	terminal any
	running  bool
	stable   bool
}

// observe читает актуальную authority и обращается к detail только по её результату.
// Пара проверок до и после detail исключает применение смешанного снимка.
func observe(ctx context.Context, task string, read Reader) (observation, error) {
	path := "/api/tasks/" + task
	first, err := readRecord(ctx, path+"/mobile-state", read)
	if err != nil {
		return observation{}, err
	}
	running, ok := first["running"].(bool)
	if !ok {
		return observation{}, failed("В снимке отсутствует running.")
	}
	identity, exists := first["identity"]
	if identity == nil && exists {
		return observePrelude(ctx, path, read)
	}
	current, err := control.Mobile(identity)
	if err != nil {
		return observation{}, failed("В снимке отсутствует exact identity.")
	}
	if running || current["terminal"] != nil {
		return observation{identity: current, running: running, stable: true}, nil
	}

	detail, err := readRecord(ctx, path, read)
	if err != nil {
		return observation{}, err
	}
	second, err := readRecord(ctx, path+"/mobile-state", read)
	if err != nil {
		return observation{}, err
	}
	return observeCursor(first, second, detail)
}

// observeCursor сохраняет второй снимок authority и определяет стабильность.
// Исторический detail проверяется позднее независимо от стабильности authority.
func observeCursor(first, second, detail control.Record) (observation, error) {
	current, exists := second["identity"]
	identity := control.Record(nil)
	if current != nil || !exists {
		var err error
		identity, err = record(current)
		if err != nil {
			return observation{}, err
		}
	}
	running, _ := second["running"].(bool)
	attempt, _ := second["attempt"].(string)
	if attempt == "" {
		attempt, _ = detail["attempt"].(string)
	}
	return observation{
		identity: identity,
		detail:   detail,
		attempt:  attempt,
		terminal: second["terminal"],
		running:  running,
		stable:   reflect.DeepEqual(first, second),
	}, nil
}

// observePrelude проверяет устойчивость подготовительной authority до и после detail.
// Утрата actionable identity без terminal оставляет состояние в ожидании при гонке фаз.
func observePrelude(ctx context.Context, path string, read Reader) (observation, error) {
	before, err := readRecord(ctx, path+"/prelude-state", read)
	if err != nil {
		return observation{}, err
	}
	detail, err := readRecord(ctx, path, read)
	if err != nil {
		return observation{}, err
	}
	after, err := readRecord(ctx, path+"/prelude-state", read)
	if err != nil {
		return observation{}, err
	}
	identity, exists := after["identity"]
	if identity != nil || !exists {
		if _, err := record(identity); err != nil {
			return observation{}, err
		}
	}
	attempt, _ := after["attempt"].(string)
	profile, _ := after["profile"].(string)
	running, ok := after["running"].(bool)
	terminal, explicit := after["terminal"]
	if !ok || !control.Matches("attempt", attempt) || !control.Matches("profile", profile) ||
		!explicit || terminal != nil && !control.Matches("state", terminal) {
		return observation{}, failed("Некорректная trusted authority подготовительной фазы.")
	}
	stable := (identity != nil || terminal != nil) && reflect.DeepEqual(before, after) &&
		detail["attempt"] == attempt && detail["profile"] == profile
	return observation{
		detail:   detail,
		attempt:  attempt,
		terminal: terminal,
		running:  running,
		stable:   stable,
	}, nil
}

// readRecord получает целый JSON-объект для одной части наблюдения.
// Ошибка транспорта остаётся исходной, ошибка формы получает код 22.
func readRecord(ctx context.Context, path string, read Reader) (control.Record, error) {
	value, err := read(ctx, path)
	if err != nil {
		return nil, err
	}
	return record(value)
}

func record(value any) (control.Record, error) {
	row, ok := value.(map[string]any)
	if !ok || row == nil {
		return nil, failed("GrigDesk вернул неверный снимок ожидания.")
	}
	return control.Record(row), nil
}

func failed(text string) error {
	return &control.Failure{Code: 22, Text: text}
}
