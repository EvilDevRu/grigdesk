package arbiter

import (
	"strings"
	"unicode/utf16"

	"grigdesk.local/tools/utilities/internal/grigdeskapi/localapi"
	"grigdesk.local/tools/utilities/pipeline/internal/control"
)

// Validate проверяет ровно тот тип намерения, который выбран аргументами CLI.
// Исходный requestId и связанные identity передаются серверу без подстановок.
func Validate(command, task string, value any) error {
	failure := control.Usage("Некорректное exact намерение арбитра.")
	if command == "arbiter-stop" {
		row, err := control.Exact(value, "operationId", "")
		if err != nil || !control.InputText(row["operationId"], 500) {
			return failure
		}
		return nil
	}
	if command == "arbiter-resume" {
		row, err := control.Exact(value, "requestId applyOperationId acceptedEvent expectedCurrentStage", "")
		if err != nil || !control.Matches("uuid", row["requestId"]) ||
			!control.InputText(row["applyOperationId"], 500) ||
			!stage(row["acceptedEvent"]) || !stage(row["expectedCurrentStage"]) {
			return failure
		}
		return nil
	}

	required := "requestId expectedStop"
	if command != "arbiter-start" {
		required += " decisionRevision"
	}
	optional := map[string]string{
		"arbiter-message":  "text questionId optionId customAnswer",
		"arbiter-diagnose": "proposalId",
		"arbiter-apply":    "proposalId customAction originalProposalId",
	}
	row, err := control.Exact(value, required, optional[command])
	if err != nil || !control.Matches("uuid", row["requestId"]) || !stop(row["expectedStop"], task) {
		return failure
	}
	if command == "arbiter-start" {
		return nil
	}
	if !control.Whole(row["decisionRevision"]) || !intent(command, row) {
		return failure
	}
	return nil
}

func stage(value any) bool {
	row, err := control.Exact(value, "sequence headEventHash", "")
	return err == nil && control.Whole(row["sequence"]) && control.Matches("digest", row["headEventHash"])
}

// stop связывает ожидаемое действие с точным head, номером шага и задачей.
// Снимок чужой остановки отвергается перед обращением к серверу.
func stop(value any, task string) bool {
	row, err := control.Exact(value, "task profile attempt node stop stageSequence stageHeadHash", "")
	return err == nil && row["task"] == task && control.Matches("task", row["task"]) &&
		control.Matches("profile", row["profile"]) && control.Matches("attempt", row["attempt"]) &&
		control.Matches("symbol", row["node"]) && control.Matches("state", row["stop"]) &&
		control.Whole(row["stageSequence"]) && control.Matches("digest", row["stageHeadHash"])
}

// intent различает обсуждение, ответ на вопрос и предложение для следующего действия.
// Наличие нескольких вариантов одновременно считается неоднозначным входом.
func intent(command string, row control.Record) bool {
	fields := make(map[string]any)
	intentFields := []string{"text", "questionId", "optionId", "customAnswer", "proposalId", "customAction"}
	for _, key := range intentFields {
		if value, exists := row[key]; exists {
			fields[key] = value
		}
	}
	if command == "arbiter-message" {
		if text, exists := fields["text"]; exists {
			return len(fields) == 1 && intentText(text, 16000)
		}
		if option, exists := fields["optionId"]; exists {
			return len(fields) == 2 && intentText(fields["questionId"], 80) && intentText(option, 80)
		}
		return len(fields) == 2 && intentText(fields["questionId"], 80) && intentText(fields["customAnswer"], 16000)
	}
	if _, exists := fields["customAction"]; exists && command == "arbiter-apply" {
		return len(fields) == 1
	}
	return len(fields) == 1 && intentText(fields["proposalId"], 80)
}

// intentText использует отдельные пределы и допустимые символы диалога арбитра.
// Адаптер не исправляет и не обрезает предоставленный текст.
func intentText(value any, limit int) bool {
	text, ok := value.(string)
	return ok && localapi.TrimSpace(text) != "" && len(utf16.Encode([]rune(text))) <= limit &&
		!strings.ContainsAny(text, "\x00\x08\x0b\x0c")
}
