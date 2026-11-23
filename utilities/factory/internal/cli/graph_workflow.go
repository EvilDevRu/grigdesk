package cli

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/graphworkflow"
	"grigdesk.local/tools/utilities/factory/internal/state"
)

var graphCommands = []string{
	"templates", "template", "template-save", "runs", "start-check", "start", "read", "result",
	"node", "input", "action", "claim", "settle", "model-open", "model-admit", "model-stop", "model-close",
}

// graphRequest — один лимитированный JSON приватного stdio, без путей и команд в теле.
type graphRequest struct {
	ID               string                    `json:"id"`
	NodeID           string                    `json:"nodeId"`
	InputKey         string                    `json:"inputKey"`
	TemplateID       string                    `json:"templateId"`
	ExpectedRevision json.RawMessage           `json:"expectedRevision"`
	Cursor           string                    `json:"cursor"`
	Limit            int                       `json:"limit"`
	Document         json.RawMessage           `json:"document"`
	Files            []graphworkflow.InputFile `json:"files"`
	ModelRef         graphworkflow.ModelRef    `json:"modelRef"`
	ResolvedModelRef *graphworkflow.ModelRef   `json:"resolvedModelRef"`
	Generation       uint64                    `json:"generation"`
	Action           string                    `json:"action"`
	Target           string                    `json:"target"`
	Comment          string                    `json:"comment"`
	Rows             []graphworkflow.Row       `json:"rows"`
	ErrorCode        string                    `json:"errorCode"`
	ClaimID          string                    `json:"claimId"`
	OwnerPid         int                       `json:"ownerPid"`
	OwnerNonce       string                    `json:"ownerNonce"`
	ScopePid         int                       `json:"scopePid"`
	CloseKind        string                    `json:"closeKind"`
}

// runGraphWorkflow передаёт системное время production-вызова обработчику.
// Тестовая сборка подставляет монотонные часы через runGraphWorkflowWithClock.
func runGraphWorkflow(args []string, stdin io.Reader, out, diagnostic io.Writer) int {
	return runGraphWorkflowWithClock(args, stdin, out, diagnostic, time.Now().UnixMilli())
}

// runGraphWorkflowWithClock принимает одну команду и один строгий JSON из stdin.
// Ответ печатается одной строкой, код выхода различает отказ, конфликт и хранилище.
func runGraphWorkflowWithClock(args []string, stdin io.Reader, out, diagnostic io.Writer, now int64) int {
	if len(args) != 1 || !slices.Contains(graphCommands, args[0]) {
		return graphReject(out, 65, "command_unknown", "command")
	}
	root := os.Getenv("FACTORY_CONTROL_ROOT")
	if root == "" {
		return graphReject(out, 65, "control_root_required", "")
	}
	raw, err := io.ReadAll(io.LimitReader(stdin, (2<<20)+1))
	if err != nil || len(raw) > 2<<20 {
		return graphReject(out, 65, "request_limit", "")
	}
	var request graphRequest
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return graphReject(out, 65, "request_invalid", "")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return graphReject(out, 65, "request_invalid", "")
	}
	store := state.Store{ControlDir: root}
	data, exit, code, field, retryAt := dispatchGraphCommand(store, args[0], request, now)
	if exit != 0 {
		return graphRejectRetry(out, exit, code, field, retryAt)
	}
	return graphRespond(out, data)
}

// dispatchGraphCommand маршрутизирует приватные подкоманды одного namespace.
// HTTP-методов для claim/settle/model-* нет, они доступны только серверу через stdio.
func dispatchGraphCommand(store state.Store, command string, request graphRequest, now int64) (any, int, string, string, int64) {
	switch command {
	case "templates":
		templates, nextCursor, err := store.ListGraphTemplates(request.Cursor)
		if err != nil {
			return graphFailure(err)
		}
		return map[string]any{"templates": templates, "nextCursor": nextCursor}, 0, "", "", 0
	case "template":
		header, document, err := store.ReadGraphTemplate(request.ID)
		if err != nil {
			return graphFailure(err)
		}
		return map[string]any{
			"id": header.ID, "revision": header.Revision, "builtIn": header.BuiltIn, "document": json.RawMessage(document),
			"requiresModel": header.RequiresModel,
		}, 0, "", "", 0
	case "template-save":
		expected, err := graphExpectedRevision(request.ExpectedRevision)
		if err != nil {
			return nil, 65, "expectedRevision_invalid", "expectedRevision", 0
		}
		header, document, err := store.SaveGraphTemplate(request.ID, expected, request.Document)
		if err != nil {
			return graphFailure(err)
		}
		return map[string]any{
			"id": header.ID, "revision": header.Revision, "builtIn": false, "document": json.RawMessage(document),
		}, 0, "", "", 0
	case "runs":
		runs, nextCursor, err := store.ListGraphRuns(request.Cursor)
		if err != nil {
			return graphFailure(err)
		}
		return map[string]any{"runs": runs, "nextCursor": nextCursor}, 0, "", "", 0
	case "start-check":
		found, revision, err := store.StartCheck(graphStartRequest(request))
		if err != nil {
			return graphFailure(err)
		}
		return map[string]any{"found": found, "revision": revision}, 0, "", "", 0
	case "start":
		revision, err := store.StartGraphRun(graphStartRequest(request), now)
		if err != nil {
			return graphFailure(err)
		}
		return map[string]any{"id": request.ID, "revision": revision}, 0, "", "", 0
	case "read":
		envelope, snapshot, err := store.ReadGraphRun(request.ID)
		if err != nil {
			return graphFailure(err)
		}
		return graphRunView(snapshot, envelope.Revision), 0, "", "", 0
	case "claim":
		claim, err := store.ClaimGraphJob(now)
		if err != nil {
			return graphFailure(err)
		}
		return claim, 0, "", "", 0
	case "settle":
		update, err := store.SettleGraphJob(graphworkflow.Settlement{
			RunID: request.ID, NodeID: request.NodeID, Generation: request.Generation,
			ClaimID: request.ClaimID, Rows: request.Rows, ErrorCode: request.ErrorCode,
		}, now)
		if err != nil {
			return graphFailure(err)
		}
		return update, 0, "", "", 0
	case "result":
		envelope, snapshot, err := store.ReadGraphRun(request.ID)
		if err != nil {
			return graphFailure(err)
		}
		return graphResultView(snapshot, envelope.Revision, request.Cursor)
	case "node":
		envelope, snapshot, err := store.ReadGraphRun(request.ID)
		if err != nil {
			return graphFailure(err)
		}
		node := snapshot.Nodes[request.NodeID]
		if node == nil {
			return nil, 44, "not_found", "nodeId", 0
		}
		return graphNodeDetail(snapshot, node, envelope.Revision), 0, "", "", 0
	case "input":
		_, snapshot, err := store.ReadGraphRun(request.ID)
		if err != nil {
			return graphFailure(err)
		}
		return graphInputView(snapshot, request.InputKey)
	case "model-open":
		receipt, err := store.ModelOpen(request.ID, request.NodeID, request.Generation,
			request.ClaimID, request.OwnerNonce, request.OwnerPid, now)
		if err != nil {
			return graphFailure(err)
		}
		return receipt, 0, "", "", 0
	case "model-admit":
		receipt, err := store.ModelAdmit(request.ID, request.NodeID, request.Generation,
			request.ClaimID, request.OwnerNonce, request.ScopePid, now)
		if err != nil {
			return graphFailure(err)
		}
		return receipt, 0, "", "", 0
	case "model-stop":
		if err := store.ModelStop(request.ID, request.ClaimID, request.OwnerNonce); err != nil {
			return graphFailure(err)
		}
		return map[string]any{"stopped": true}, 0, "", "", 0
	case "model-close":
		var settlement *graphworkflow.Settlement
		if request.Rows != nil || request.ErrorCode != "" {
			settlement = &graphworkflow.Settlement{
				RunID: request.ID, NodeID: request.NodeID, Generation: request.Generation,
				ClaimID: request.ClaimID, Rows: request.Rows, ErrorCode: request.ErrorCode,
			}
		}
		receipt, err := store.ModelClose(request.ID, request.NodeID, request.Generation,
			request.ClaimID, request.OwnerNonce, request.CloseKind, settlement, now)
		if err != nil {
			return graphFailure(err)
		}
		return receipt, 0, "", "", 0
	case "action":
		var expected uint64
		if err := json.Unmarshal(request.ExpectedRevision, &expected); err != nil {
			return nil, 65, "expectedRevision_invalid", "expectedRevision", 0
		}
		update, err := store.ActionGraphRun(request.ID, expected, request.NodeID, request.Generation,
			request.Action, request.Target, request.Comment, now)
		if err != nil {
			return graphFailure(err)
		}
		return update, 0, "", "", 0
	default:
		return nil, 65, "command_not_ready", "command", 0
	}
}

func graphStartRequest(request graphRequest) state.GraphStartRequest {
	expected, _ := graphExpectedRevision(request.ExpectedRevision)
	value := state.GraphStartRequest{
		ID:               request.ID,
		TemplateID:       request.TemplateID,
		Files:            request.Files,
		ModelRef:         request.ModelRef,
		ResolvedModelRef: request.ResolvedModelRef,
	}
	if expected != nil {
		value.ExpectedRevision = *expected
	}
	return value
}

func graphExpectedRevision(raw json.RawMessage) (*string, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return &value, nil
}

// graphErrorExit различает конфликт, отсутствие записи, права и повреждение.
// Валидатор графа отдаёт поле первой частью сообщения, без traceback и путей.
func graphErrorExit(err error) (int, string, string, int64) {
	var paused state.GraphAdmissionPausedError
	switch {
	case errors.As(err, &paused):
		return 76, "workflow_admission_paused", "", paused.Until
	case errors.Is(err, state.ErrConflict):
		return 75, "conflict", "", 0
	case errors.Is(err, state.ErrGraphNotFound):
		return 44, "not_found", "", 0
	case errors.Is(err, state.ErrGraphBuiltinReadonly):
		return 65, "builtin_readonly", "id", 0
	case errors.Is(err, state.ErrGraphBroken):
		return 76, "graph_broken", "", 0
	case errors.Is(err, os.ErrNotExist):
		return 44, "not_found", "", 0
	case errors.Is(err, os.ErrPermission):
		return 76, "workflow_store_unavailable", "", 0
	default:
		message := err.Error()
		switch message {
		case "workflow_storage_invalid":
			return 76, message, "", 0
		case "active_workflow_limit":
			return 76, message, "", 0
		case "operation_limit":
			return 75, message, "", 0
		case "process_exit_unconfirmed":
			return 75, message, "", 0
		case "stale_claim":
			return 75, message, "", 0
		}
		field, _, _ := strings.Cut(message, ":")
		return 65, message, field, 0
	}
}

// graphFailure переносит код ошибки хранилища в форму ответа диспетчера.
func graphFailure(err error) (any, int, string, string, int64) {
	exit, code, field, retryAt := graphErrorExit(err)
	return nil, exit, code, field, retryAt
}

type graphResultCursor struct {
	RunID    string `json:"runId"`
	Revision uint64 `json:"revision"`
	Offset   int    `json:"offset"`
}

// graphResultView отдаёт одну страницу сводки до 64 КиБ строк.
// Курсор сверяет ID и ревизию снимка, устаревший даёт result_changed.
func graphResultView(snapshot *graphworkflow.Snapshot, revision uint64, cursorRaw string) (any, int, string, string, int64) {
	preview := snapshot.PreviewResult()
	offset := 0
	if cursorRaw != "" {
		if len(cursorRaw) > 128 {
			return nil, 65, "cursor_invalid", "cursor", 0
		}
		decoded, err := base64.RawURLEncoding.DecodeString(cursorRaw)
		var cursor graphResultCursor
		if err != nil || json.Unmarshal(decoded, &cursor) != nil {
			return nil, 65, "cursor_invalid", "cursor", 0
		}
		if cursor.RunID != snapshot.ID || cursor.Revision != revision {
			return nil, 75, "result_changed", "", 0
		}
		offset = cursor.Offset
		if offset < 0 || offset >= len(preview.Rows) {
			return nil, 65, "cursor_invalid", "cursor", 0
		}
	}
	page := make([]graphworkflow.Row, 0)
	size := 0
	index := offset
	for ; index < len(preview.Rows); index++ {
		raw, err := json.Marshal(preview.Rows[index])
		if err != nil {
			return nil, 76, "workflow_store_unavailable", "", 0
		}
		if size+len(raw) > 64*1024 && len(page) > 0 {
			break
		}
		page = append(page, preview.Rows[index])
		size += len(raw)
	}
	var nextCursor any
	if index < len(preview.Rows) {
		raw, _ := json.Marshal(graphResultCursor{RunID: snapshot.ID, Revision: revision, Offset: index})
		nextCursor = base64.RawURLEncoding.EncodeToString(raw)
	}
	status := snapshot.Status()
	inputs := make([]map[string]string, 0, len(snapshot.Manifest))
	for position, file := range snapshot.Manifest {
		inputs = append(inputs, map[string]string{"key": fmt.Sprintf("file-%d", position+1), "name": file.Name})
	}
	return map[string]any{
		"revision": revision, "incomplete": preview.Incomplete || status != "done",
		"nextCursor": nextCursor, "inputs": inputs, "rows": page,
		"missing": preview.Missing, "approvals": preview.Approvals,
	}, 0, "", "", 0
}

// graphNodeDetail отдаёт точное preview узла, попытки и действия ворот.
// Строки ворот разворачиваются из их замороженных DataRefs, не из общей сводки.
func graphNodeDetail(snapshot *graphworkflow.Snapshot, node *graphworkflow.Instance, revision uint64) map[string]any {
	rows := make([]graphworkflow.Row, 0)
	var previewErr error
	if node.Status == "done" || node.Status == "waiting" {
		var expanded []graphworkflow.Row
		expanded, previewErr = snapshot.RowsFor(
			graphworkflow.ResultRef{ID: node.ID, Generation: node.Generation}, graphworkflow.ReviewOutputLimit)
		if previewErr == nil {
			rows = expanded
		}
	}
	attempts := 0
	for _, event := range snapshot.Events {
		if event.NodeID == node.ID && (event.Kind == "settle" || event.Kind == "expire") {
			attempts++
		}
	}
	inputs := make([]map[string]string, 0, len(snapshot.Manifest))
	for position, file := range snapshot.Manifest {
		inputs = append(inputs, map[string]string{"key": fmt.Sprintf("file-%d", position+1), "name": file.Name})
	}
	view := map[string]any{
		"id": node.ID, "generation": node.Generation, "revision": revision,
		"status": node.Status, "rows": rows, "attempts": attempts, "inputs": inputs,
	}
	if node.ErrorCode != "" {
		view["errorCode"] = node.ErrorCode
	}
	if previewErr != nil {
		view["errorCode"] = "output_limit"
	}
	if node.Kind == "approval" {
		switch node.Status {
		case "waiting":
			rejectMode := "close"
			targets := snapshot.ReviewTargets(node)
			if len(targets) > 0 {
				rejectMode = "return"
			}
			view["approval"] = map[string]any{
				"state":         "pending",
				"reviewActions": map[string]any{"approve": previewErr == nil, "rejectMode": rejectMode, "targets": targets},
			}
		case "done":
			view["approval"] = map[string]any{"state": "approved"}
		case "failed":
			if node.ErrorCode == "rejected" {
				comment := ""
				for _, event := range snapshot.Events {
					if event.Kind == "decision" && event.NodeID == node.ID && event.Approve != nil && !*event.Approve {
						comment = event.Comment
					}
				}
				view["approval"] = map[string]any{"state": "rejected", "comment": comment}
			}
		}
	}
	return view
}

// graphInputView читает сохранённый манифест по точному ключу входа.
// JSON-расшифровка восстанавливает исходные метки элементов, включая пустые.
func graphInputView(snapshot *graphworkflow.Snapshot, inputKey string) (any, int, string, string, int64) {
	if !strings.HasPrefix(inputKey, "file-") {
		return nil, 65, "inputKey_invalid", "inputKey", 0
	}
	position, err := strconv.Atoi(strings.TrimPrefix(inputKey, "file-"))
	if err != nil || position < 1 || position > len(snapshot.Manifest) {
		return nil, 44, "not_found", "inputKey", 0
	}
	file := snapshot.Manifest[position-1]
	view := map[string]any{"key": inputKey, "name": file.Name, "text": file.Text}
	if snapshot.Definition.InputKind == "transcript" && strings.EqualFold(filepath.Ext(file.Name), ".json") {
		segments, err := graphworkflow.TranscriptSegments(file.Text)
		if err != nil {
			return nil, 76, "graph_broken", "", 0
		}
		view["segments"] = segments
	}
	return view, 0, "", "", 0
}

type graphNodeView struct {
	ID         string         `json:"id"`
	Parent     string         `json:"parent"`
	Title      string         `json:"title"`
	Kind       string         `json:"kind"`
	Status     string         `json:"status"`
	Generation uint64         `json:"generation"`
	After      []string       `json:"after"`
	Members    []string       `json:"members"`
	Slot       int            `json:"slot"`
	Outputs    []string       `json:"outputs,omitempty"`
	ErrorCode  string         `json:"errorCode,omitempty"`
	Counts     map[string]int `json:"counts,omitempty"`
}

// graphRunView проецирует снимок в DTO схемы без содержимого выходов.
// Ревизия берётся из оболочки, clock не является HTTP-ревизией.
func graphRunView(snapshot *graphworkflow.Snapshot, revision uint64) map[string]any {
	nodes := make([]graphNodeView, 0, len(snapshot.Order))
	for _, id := range snapshot.Order {
		node := snapshot.Nodes[id]
		if node == nil {
			continue
		}
		decl := snapshot.DeclOf(node)
		after := make([]string, 0, len(decl.Needs))
		for _, need := range decl.Needs {
			dependency := node.Prefix + need
			if snapshot.Nodes[dependency] != nil {
				after = append(after, dependency)
			}
		}
		view := graphNodeView{
			ID: node.ID, Parent: node.Parent, Title: node.Title, Kind: node.Kind,
			Status: node.Status, Generation: node.Generation, After: after,
			Members: node.Members, Slot: node.Slot, ErrorCode: node.ErrorCode,
		}
		if view.Members == nil {
			view.Members = []string{}
		}
		if node.Kind == "forEach" || node.Kind == "call" || node.Kind == "repeat" {
			view.Outputs = snapshot.GroupOutputs(node)
			total, done, running, failed := snapshot.GroupCounts(node)
			view.Counts = map[string]int{"total": total, "done": done, "running": running, "failed": failed}
		}
		nodes = append(nodes, view)
	}
	return map[string]any{
		"id": snapshot.ID, "title": snapshot.Title, "revision": revision,
		"status": snapshot.Status(), "nodes": nodes, "templateId": snapshot.TemplateID,
	}
}

func graphRespond(out io.Writer, data any) int {
	raw, err := json.Marshal(map[string]any{"ok": true, "data": data})
	if err != nil {
		return graphReject(out, 76, "workflow_store_unavailable", "")
	}
	if _, err := fmt.Fprintln(out, string(raw)); err != nil {
		return 1
	}
	return 0
}

func graphReject(out io.Writer, exit int, code, field string) int {
	return graphRejectRetry(out, exit, code, field, 0)
}

func graphRejectRetry(out io.Writer, exit int, code, field string, retryAt int64) int {
	value := map[string]any{"ok": false, "error": code}
	if field != "" {
		value["field"] = field
	}
	if retryAt > 0 {
		value["retryAt"] = retryAt
	}
	raw, _ := json.Marshal(value)
	fmt.Fprintln(out, string(raw))
	return exit
}
