package cli

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/json/jsontext"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf16"

	"grigdesk.local/tools/utilities/factory/internal/state"
)

var stageSettingsRequestID = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

type stageSettingsApply struct {
	ExpectedRevision uint64
	ExpectedRun      *state.StageRunnerEpoch
	Restart          bool
	CatalogRevision  string
	Selection        state.StageRunnerSelection
	Receipt          state.StageRunnerReceipt
}

// parseStageSettingsApply проверяет закрытую схему даже при вызове без сервера.
// Режим next связывает запрос с наблюдаемой эпохой либо остановленной задачей.
func parseStageSettingsApply(raw string, expected state.StageRunnerIdentity) (stageSettingsApply, error) {
	var result stageSettingsApply
	if len(raw) > 48*1024 {
		return result, fmt.Errorf("settings_input: слишком большой payload")
	}
	fields := closedSettingsObject([]byte(raw),
		"identity", "expectedRevision", "expectedRun", "catalogRevision", "requestId", "mode", "selection")
	if fields == nil {
		return result, fmt.Errorf("settings_input: неверные поля apply")
	}
	var identity state.StageRunnerIdentity
	keys := []string{"task", "profile", "attempt", "node", "stage"}
	if closedSettingsObject(fields["identity"], keys...) == nil ||
		json.Unmarshal(fields["identity"], &identity) != nil || identity != expected {
		return result, stageSettingsConflict("identity_conflict: запрос относится к другому узлу")
	}
	var mode string
	if json.Unmarshal(fields["mode"], &mode) != nil || (mode != "next" && mode != "restart") {
		return result, fmt.Errorf("settings_input: неизвестный режим сохранения")
	}
	var expectedRun *state.StageRunnerEpoch
	if string(fields["expectedRun"]) != "null" {
		rawRun := fields["expectedRun"]
		if closedSettingsObject(rawRun, "id", "epoch") == nil ||
			json.Unmarshal(rawRun, &expectedRun) != nil || expectedRun == nil || !expectedRun.Valid() {
			return result, fmt.Errorf("settings_input: неверный expectedRun")
		}
	}
	if mode == "restart" && expectedRun == nil {
		return result, stageSettingsConflict("identity_conflict: перезапуск требует живую эпоху")
	}
	var revision *uint64
	var catalog, requestID string
	if json.Unmarshal(fields["expectedRevision"], &revision) != nil || revision == nil ||
		*revision > 9007199254740991 || json.Unmarshal(fields["catalogRevision"], &catalog) != nil ||
		!sha256Hex.MatchString(catalog) || json.Unmarshal(fields["requestId"], &requestID) != nil ||
		!stageSettingsRequestID.MatchString(requestID) {
		return result, fmt.Errorf("settings_input: неверные revision, catalogRevision или requestId")
	}
	selection, err := parseStageSettingsSelection(fields["selection"])
	if err != nil {
		return result, err
	}
	payloadHash, err := stageSettingsDigest([]byte(raw))
	if err != nil {
		return result, err
	}
	status := "saved"
	if mode == "restart" {
		status = "pending"
	}
	return stageSettingsApply{
		ExpectedRevision: *revision, ExpectedRun: expectedRun, Restart: mode == "restart",
		CatalogRevision: catalog, Selection: selection,
		Receipt: state.StageRunnerReceipt{RequestID: requestID, PayloadHash: payloadHash, State: status},
	}, nil
}

func parseStageSettingsSelection(raw []byte) (state.StageRunnerSelection, error) {
	var selection stageSettingsSelection
	if closedSettingsObject(raw, "primary", "parametersFor", "model", "effort") == nil ||
		json.Unmarshal(raw, &selection) != nil || !runnerID.MatchString(selection.ParametersFor) ||
		(selection.Primary != nil && *selection.Primary != selection.ParametersFor) {
		return state.StageRunnerSelection{}, fmt.Errorf("settings_input: неверная selection")
	}
	for _, value := range []*string{selection.Model, selection.Effort} {
		if value != nil && (len(utf16.Encode([]rune(*value))) > 2048 ||
			strings.ContainsFunc(*value, func(r rune) bool { return r < 32 })) {
			return state.StageRunnerSelection{}, fmt.Errorf("settings_input: неверное значение selection")
		}
	}
	var primary string
	if selection.Primary != nil {
		primary = *selection.Primary
	}
	return state.StageRunnerSelection{Primary: primary, ParametersFor: selection.ParametersFor,
		Model: selection.Model, Effort: selection.Effort}, nil
}

// closedSettingsObject исключает неизвестные, отсутствующие и повторные поля.
// На выходе остаются оригинальные JSON-значения для типизированной проверки.
func closedSettingsObject(raw []byte, keys ...string) map[string]json.RawMessage {
	var fields map[string]json.RawMessage
	if !jsontext.Value(raw).IsValid() || json.Unmarshal(raw, &fields) != nil || len(fields) != len(keys) {
		return nil
	}
	for _, key := range keys {
		if fields[key] == nil {
			return nil
		}
	}
	return fields
}

// stageSettingsDigest сохраняет совместимость с отсортированным ASCII JSON прежнего writer.
// Все имена полей схемы ASCII. Значения Unicode кодируются кодовыми единицами UTF-16.
func stageSettingsDigest(raw []byte) (string, error) {
	var fields any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&fields); err != nil {
		return "", err
	}
	var jsonBuffer bytes.Buffer
	encoder := json.NewEncoder(&jsonBuffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(fields); err != nil {
		return "", err
	}
	var ascii strings.Builder
	for _, value := range strings.TrimSuffix(jsonBuffer.String(), "\n") {
		if value < 127 {
			ascii.WriteRune(value)
			continue
		}
		for _, word := range utf16.Encode([]rune{value}) {
			fmt.Fprintf(&ascii, "\\u%04x", word)
		}
	}
	hash := sha256.Sum256([]byte(ascii.String()))
	return hex.EncodeToString(hash[:]), nil
}
