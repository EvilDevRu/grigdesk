package engine

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"encoding/json/jsontext"
	jsonv2 "encoding/json/v2"
	"errors"
	"fmt"
	"os"
	"regexp"
	"slices"
	"strings"

	"grigdesk.local/tools/utilities/factory/internal/route"
	"grigdesk.local/tools/utilities/factory/internal/runner"
	"grigdesk.local/tools/utilities/factory/internal/state"
)

var scoutRunID = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
var scoutDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)

// bootstrap проверяет политику закреплённого маршрута до открытия main cursor.
// Уже сохранённый checkpoint подтверждается без обращения к текущему SCOUT.active.
func (e execution) bootstrap(ctx context.Context) (int, error) {
	if e.bundle.Machine["bootstrap"] == "skip" {
		return 0, nil
	}
	if err := ctx.Err(); err != nil {
		return 130, err
	}
	store, a := e.request.Store, e.attempt
	raw, _, err := store.AttemptArtifact(a, "bootstrap.json", nil, false)
	if os.IsNotExist(err) {
		return e.executeScout(ctx)
	}
	if err != nil {
		return 78, err
	}
	if err := e.checkScout(raw); err != nil {
		return 78, err
	}
	return projectResult(store.CompleteBootstrap(a, raw))
}

// executeScout передаёт провайдеру закреплённый узел и узкую state capability.
// Основной cursor открывается только после проверенного checkpoint.
func (e execution) executeScout(ctx context.Context) (code int, failure error) {
	store, a := e.request.Store, e.attempt
	bundle, err := e.scoutBundle()
	if err != nil {
		return 78, err
	}
	node, err := e.scoutNode(bundle)
	if err != nil {
		return 78, err
	}
	visit, evidence, err := store.BeginBootstrap(a)
	if err != nil {
		return projectResult(err)
	}
	cursor := state.StageSnapshot{CurrentNode: "scout"}
	prompt, err := e.scoutPrompt(bundle, cursor, evidence)
	if err != nil {
		return 78, err
	}
	request, err := e.runnerRequest(cursor, node, "SCOUT", prompt)
	if err != nil {
		return 78, err
	}
	request.Role = ""
	var runs []state.BootstrapRun
	onlyNoResult := true
	request.BeforeInvoke, request.AfterInvoke = e.workspaceGuard(ctx, func(result runner.DispatchResult) {
		runs = append(runs, state.BootstrapRun{Run: result.Run, Result: result.Terminal.Result})
		onlyNoResult = onlyNoResult && result.Classification == "no_result"
	})
	if err := e.project(state.ProjectionField{Key: "SCOUT", Value: "running"}); err != nil {
		return 78, err
	}
	closeSpan, err := e.beginScoutSpan()
	if err != nil {
		return 78, err
	}
	defer func() {
		if err := closeSpan(code); err != nil {
			code, failure = 78, errors.Join(failure, err)
		}
	}()
	result, err := e.dispatchAgent(ctx, request)
	if errors.Is(err, context.Canceled) {
		return 130, err
	}
	if err != nil {
		return 75, err
	}
	if result.Terminal.Result == "done" {
		return projectResult(e.publishScout(bundle, result))
	}
	if result.Classification == "exhausted" && !onlyNoResult {
		return 75, fmt.Errorf("SCOUT: один из запусков завершился отказом провайдера")
	}
	return e.stopScout(visit, result, runs)
}

func (e execution) projectScoutPause() error {
	return e.project(state.ProjectionField{Key: "STALLED_HUMAN", Value: "1"},
		state.ProjectionField{Key: "RESULT", Value: "stopped-bootstrap-human"})
}

// scoutNode проверяет все возможные ветви до запуска модели.
// Неподдерживаемая топология не даёт побочных эффектов провайдера.
func (e execution) scoutNode(bundle route.MachineBundle) (map[string]any, error) {
	nodes, _ := bundle.Machine["nodes"].([]any)
	if len(nodes) != 1 || bundle.Machine["entry"] != "scout" {
		return nil, fmt.Errorf("bootstrap: поддерживается один отдельный SCOUT")
	}
	node, _ := nodes[0].(map[string]any)
	policy, _ := node["policy"].(map[string]any)
	if node["id"] != "scout" || node["executor"] != "agent" || node["runKey"] != "SCOUT" ||
		node["phase"] != "bootstrap" || policy["filesystem"] != "state-only" {
		return nil, fmt.Errorf("bootstrap: требуется state-only SCOUT")
	}
	if _, err := e.scoutTransition(bundle); err != nil {
		return nil, err
	}
	for _, outcome := range []string{"failed", "skipped", "exhausted"} {
		owners := []string{""}
		if outcome == "failed" {
			owners = append(owners, "build", "tests", "environment", "plan", "human")
		}
		for _, owner := range owners {
			next, err := bundle.Transition("scout", outcome, owner)
			action, _ := next["action"].(map[string]any)
			if err != nil || action["stop"] != "human" {
				return nil, fmt.Errorf("bootstrap: неподдерживаемый переход %s/%s", outcome, owner)
			}
		}
	}
	return node, nil
}

// scoutPrompt добавляет подтверждённый вопрос и ответ к обычному typed context.
// Служебный блок доставляет ответ и старым prompt без обязательной секции evidence.
func (e execution) scoutPrompt(
	bundle route.MachineBundle, cursor state.StageSnapshot, decision map[string]any,
) (string, error) {
	args, err := e.contextArgs(cursor, "SCOUT", true)
	if err != nil {
		return "", err
	}
	var raw, diagnostic bytes.Buffer
	if rc := route.RunContext(args, &raw, &diagnostic); rc != 0 {
		return "", fmt.Errorf("контекст SCOUT rc=%d: %s", rc, diagnostic.String())
	}
	if decision == nil {
		return route.RenderBundle(bundle, "scout", raw.Bytes())
	}
	var value map[string]any
	if err := json.Unmarshal(raw.Bytes(), &value); err != nil {
		return "", err
	}
	evidence, _ := value["evidence"].(map[string]any)
	evidence["bootstrapDecision"] = decision
	contextJSON, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	prompt, err := route.RenderBundle(bundle, "scout", contextJSON)
	if err != nil {
		return "", err
	}
	block, err := encodeScoutTransition(decision)
	if err != nil {
		return "", err
	}
	return prompt + "\nДАННЫЕ ПОДТВЕРЖДЁННОГО ВОПРОСА И ОТВЕТА SCOUT\n" + string(block), nil
}

// publishScout связывает успешный terminal с новым checkpoint.
// Запись completed можно безопасно достроить из уже проверенного файла.
func (e execution) publishScout(bundle route.MachineBundle, result runner.DispatchResult) error {
	a := e.attempt
	transition, err := e.scoutTransition(bundle)
	if err != nil {
		return err
	}
	raw, err := encodeScoutTransition(transition)
	if err != nil {
		return err
	}
	verdict, err := state.ParseRunVerdict("done", result.Terminal.Verdict)
	if err != nil {
		return err
	}
	checkpoint, err := encodeScoutTransition(map[string]any{
		"schema": 2, "protocolVersion": 2, "taskId": a.Task, "attemptId": a.ID, "profile": a.Profile,
		"catalogHash": a.CatalogHash, "routeId": a.RouteID, "routeHash": a.RouteHash,
		"node": "scout", "runKey": "SCOUT", "result": "done", "runId": result.Run.ID,
		"epoch": result.Run.Epoch, "verdict": verdict, "transitionHash": fmt.Sprintf("%x", sha256.Sum256(raw)),
	})
	if err != nil {
		return err
	}
	if err := e.checkScout(checkpoint); err != nil {
		return err
	}
	if _, _, err := e.request.Store.AttemptArtifact(a, "bootstrap.json", checkpoint, true); err != nil {
		return err
	}
	return e.request.Store.CompleteBootstrap(a, checkpoint)
}

// stopScout выпускает вопрос только из известного terminal или доказанного молчания.
// Отказы адаптера и ошибки среды остаются ошибками хоста.
func (e execution) stopScout(
	visit string, result runner.DispatchResult, runs []state.BootstrapRun,
) (int, error) {
	terminal := result.Terminal
	outcome, reason := terminal.Result, terminal.Comment
	if result.Classification == "exhausted" && outcome == "" {
		outcome = "exhausted"
		reason = fmt.Sprintf("SCOUT: исчерпан бюджет повторов — %d исполнений без результата", len(runs))
	}
	if outcome != "failed" && outcome != "skipped" && outcome != "exhausted" {
		return 78, fmt.Errorf("SCOUT: неподтверждённый исход")
	}
	if err := e.request.Store.StopBootstrap(e.attempt, visit, outcome, strings.TrimSpace(reason),
		terminal.Verdict, runs); err != nil {
		return 78, err
	}
	return 22, errors.New("разведка ждёт решения человека")
}

// checkScout сверяет legacy и текущую формы checkpoint с immutable catalog pin.
// Новый checkpoint дополнительно хранит точный хэш bootstrap transition.
func (e execution) checkScout(raw []byte) error {
	record := make(map[string]any)
	if len(raw) > 1024*1024 || !jsontext.Value(raw).IsValid() || json.Unmarshal(raw, &record) != nil {
		return fmt.Errorf("bootstrap: испорченный checkpoint")
	}
	a := e.attempt
	required := map[string]any{"protocolVersion": float64(2), "taskId": a.Task, "attemptId": a.ID,
		"profile": a.Profile, "catalogHash": a.CatalogHash, "routeId": a.RouteID, "routeHash": a.RouteHash,
		"node": "scout", "runKey": "SCOUT", "result": "done"}
	for fields, expected := range required {
		if record[fields] != expected {
			return fmt.Errorf("bootstrap: checkpoint расходится с pin поля %s", fields)
		}
	}
	run, _ := record["runId"].(string)
	hash, _ := record["transitionHash"].(string)
	version, _ := record["schema"].(float64)
	if !scoutRunID.MatchString(run) || !scoutDigest.MatchString(hash) ||
		(version != 1 && version != 2) || len(record) != len(required)+int(version)*2+1 {
		return fmt.Errorf("bootstrap: неверная форма checkpoint")
	}
	bundle, err := e.scoutBundle()
	if err != nil {
		return err
	}
	transition, err := e.scoutTransition(bundle)
	if err != nil {
		return err
	}
	if version == 1 {
		return nil
	}
	epoch, ok := record["epoch"].(float64)
	if !ok || epoch < 1 || epoch > 9007199254740991 || epoch != float64(uint64(epoch)) {
		return fmt.Errorf("bootstrap: неверная epoch")
	}
	verdict, ok := record["verdict"]
	if !ok {
		return fmt.Errorf("bootstrap: отсутствует поле verdict")
	}
	if verdict != nil {
		raw, err := jsonv2.Marshal(verdict, jsonv2.Deterministic(true))
		if err != nil {
			return err
		}
		if _, err := state.ParseRunVerdict("done", base64.StdEncoding.EncodeToString(raw)); err != nil {
			return err
		}
	}
	encoded, err := encodeScoutTransition(transition)
	if err != nil || hash != fmt.Sprintf("%x", sha256.Sum256(encoded)) {
		return fmt.Errorf("bootstrap: неверный transition hash")
	}
	return nil
}

func (e execution) scoutBundle() (route.MachineBundle, error) {
	a := e.attempt
	reader, err := route.NewBundleReader(a.RoutesDir, a.Profile)
	if err != nil {
		return route.MachineBundle{}, err
	}
	catalog, err := reader.ReadCatalog(a.CatalogHash)
	return catalog.Bootstrap, err
}

// scoutTransition подтверждает, что получатель escalation совпадает с route pin.
// Канонический envelope сохраняет совместимость с историческим checkpoint.
func (e execution) scoutTransition(bundle route.MachineBundle) (map[string]any, error) {
	next, err := bundle.Transition("scout", "done", "")
	if err != nil {
		return nil, err
	}
	action, _ := next["action"].(map[string]any)
	escalation, _ := action["escalate"].(map[string]any)
	allowed, _ := escalation["routes"].([]any)
	policy, _ := next["escalationPolicy"].(map[string]any)
	if !slices.Contains(allowed, any(e.attempt.RouteID)) || policy["requiresHumanWhenPinned"] != true {
		return nil, fmt.Errorf("bootstrap: успешная разведка не подтверждает выбранный маршрут")
	}
	next["schema"], next["catalogHash"], next["phase"] = 2, e.attempt.CatalogHash, "bootstrap"
	return next, nil
}

func encodeScoutTransition(value map[string]any) ([]byte, error) {
	var result bytes.Buffer
	writer := json.NewEncoder(&result)
	writer.SetIndent("", "  ")
	writer.SetEscapeHTML(false)
	err := writer.Encode(value)
	return result.Bytes(), err
}
