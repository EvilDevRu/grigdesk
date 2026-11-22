package state

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/host"
)

type StatusSubmission struct {
	Result, Comment, Verdict string
	Progress                 []ProjectionField
}

// StatusRequestDir выводит прежний state-only каталог из полной run identity.
// Обе стороны сравнивают его с назначением хоста до открытия очереди.
func (s Store) StatusRequestDir(id RunIdentity) string {
	return filepath.Join(s.StateDir, "logs", "runs", "t"+id.Task, id.Stage, id.ID, "control-requests")
}

func (s Store) openStatusRequests(id RunIdentity) (*os.Root, error) {
	if !id.Valid() {
		return nil, fmt.Errorf("неверная identity каталога запросов")
	}
	dir := s.StatusRequestDir(id)
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return nil, err
	}
	if resolved != dir || !filepath.IsAbs(dir) {
		return nil, fmt.Errorf("каталог запросов запрещает symlink-компоненты")
	}
	return openControl(dir, false)
}

// QueueStatus проверяет запрос модели и пишет envelope в state-only каталог.
// Успешная публикация подтверждает приём заявки файловой очередью.
func (s Store) QueueStatus(id RunIdentity, dir string, input StatusSubmission) (int, error) {
	if dir != s.StatusRequestDir(id) || !id.Valid() {
		return 74, fmt.Errorf("каталог или identity статусного запроса не совпадают")
	}
	var data strings.Builder
	fmt.Fprintf(&data, "SCHEMA=1\nTASK=%s\nSTAGE=%s\nRUN_ID=%s\nEPOCH=%d\nATTEMPT_ID=%s\n",
		id.Task, id.Stage, id.ID, id.Epoch, id.Attempt)
	if input.Result == "" {
		if err := ValidateRunProgress(id.Stage, input.Progress); err != nil {
			return 2, err
		}
		fmt.Fprintf(&data, "TYPE=progress\nCOUNT=%d\n", len(input.Progress))
		for i, field := range input.Progress {
			value := base64.StdEncoding.EncodeToString([]byte(field.Value))
			fmt.Fprintf(&data, "KEY_%d=%s\nVALUE_%d_B64=%s\n", i, field.Key, i, value)
		}
	} else {
		if !validRunResult(input.Result) || len(input.Comment) > 20000 ||
			strings.ContainsRune(input.Comment, 0) {
			return 2, fmt.Errorf("stage-result: неверный результат или комментарий")
		}
		if _, err := ParseRunVerdict(input.Result, input.Verdict); err != nil {
			return 2, err
		}
		comment := base64.StdEncoding.EncodeToString([]byte(input.Comment))
		fmt.Fprintf(&data, "TYPE=result\nRESULT=%s\nCOMMENT_B64=%s\nVERDICT_B64=%s\n",
			input.Result, comment, input.Verdict)
	}
	root, err := s.openStatusRequests(id)
	if err != nil {
		return 74, err
	}
	defer root.Close()
	name := fmt.Sprintf("%020d-%s.request", time.Now().UnixNano(), rand.Text())
	if err := publishFile(root, name, []byte(data.String()), ownerMode, false); err != nil {
		return 74, err
	}
	return 0, nil
}

// ConsumeStatusRequests принимает валидные запросы с capability хоста.
// Уже принятый terminal имеет совместимый код 75 и удаляется из очереди.
func (s Store) ConsumeStatusRequests(id RunIdentity, token string) (int, error) {
	root, err := s.openStatusRequests(id)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 74, err
	}
	defer root.Close()
	files, err := fs.ReadDir(root.FS(), ".")
	if err != nil {
		return 74, err
	}
	for _, file := range files {
		if !file.Type().IsRegular() || !strings.HasSuffix(file.Name(), ".request") {
			continue
		}
		data, err := readTrusted(root, file.Name(), runRecordLimit, ownerMode)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return 74, err
		}
		request, err := parseStatusRequest(id, data)
		if err != nil {
			return 74, err
		}
		var rc int
		if request.Result == "" {
			rc, err = s.ApplyRunProgress(id, token, request.Progress)
		} else {
			rc, err = s.ApplyRunResult(id, token, request.Result, request.Comment, request.Verdict)
		}
		if rc != 0 && rc != 75 {
			return rc, err
		}
		if err := root.Remove(file.Name()); err != nil && !errors.Is(err, os.ErrNotExist) {
			return 74, err
		}
	}
	if err := host.SyncDirectory(root, "."); err != nil {
		return 74, err
	}
	return 0, nil
}

// parseStatusRequest повторно проверяет поля из writable каталога на стороне хоста.
// Подложенный файл не даёт полномочий на другой запуск или административный ключ.
func parseStatusRequest(id RunIdentity, raw []byte) (StatusSubmission, error) {
	fields, err := parseRunFields(raw)
	if err != nil {
		return StatusSubmission{}, err
	}
	attempt := fields["ATTEMPT_ID"]
	if fields["SCHEMA"] != "1" || fields["TASK"] != id.Task || fields["STAGE"] != id.Stage ||
		fields["RUN_ID"] != id.ID || fields["EPOCH"] != strconv.FormatUint(id.Epoch, 10) ||
		(attempt != "" && attempt != id.Attempt) {
		return StatusSubmission{}, fmt.Errorf("статусный запрос относится к другому запуску")
	}
	baseCount := 6
	if _, exists := fields["ATTEMPT_ID"]; exists {
		baseCount++
	}
	switch fields["TYPE"] {
	case "result":
		comment, err := decodeStatusValue(fields["COMMENT_B64"])
		_, hasComment := fields["COMMENT_B64"]
		verdict, hasVerdict := fields["VERDICT_B64"]
		if err != nil || !validRunResult(fields["RESULT"]) ||
			len(fields) != baseCount+3 || !hasComment || !hasVerdict {
			return StatusSubmission{}, fmt.Errorf("испорчен deferred terminal")
		}
		if _, err := ParseRunVerdict(fields["RESULT"], verdict); err != nil {
			return StatusSubmission{}, err
		}
		return StatusSubmission{Result: fields["RESULT"], Comment: comment, Verdict: verdict}, nil
	case "progress":
		updates, err := parseStatusProgress(id.Stage, fields, baseCount)
		return StatusSubmission{Progress: updates}, err
	default:
		return StatusSubmission{}, fmt.Errorf("неизвестный тип статусного запроса")
	}
}

func parseStatusProgress(stage string, fields map[string]string, baseCount int) ([]ProjectionField, error) {
	count, err := strconv.Atoi(fields["COUNT"])
	if err != nil || count < 1 || count > 64 || len(fields) != baseCount+1+count*2 {
		return nil, fmt.Errorf("испорчен deferred progress")
	}
	updates := make([]ProjectionField, count)
	for i := range updates {
		key := fields[fmt.Sprintf("KEY_%d", i)]
		value, err := decodeStatusValue(fields[fmt.Sprintf("VALUE_%d_B64", i)])
		if err != nil {
			return nil, err
		}
		updates[i] = ProjectionField{Key: key, Value: value}
	}
	return updates, ValidateRunProgress(stage, updates)
}

func decodeStatusValue(value string) (string, error) {
	if strings.ContainsAny(value, "\r\n") || len(value) > base64.StdEncoding.EncodedLen(20000) {
		return "", fmt.Errorf("неверный размер или base64 статусного поля")
	}
	raw, err := base64.StdEncoding.Strict().DecodeString(value)
	if err != nil || len(raw) > 20000 || strings.ContainsRune(string(raw), 0) {
		return "", fmt.Errorf("испорчено статусное поле")
	}
	return string(raw), nil
}
