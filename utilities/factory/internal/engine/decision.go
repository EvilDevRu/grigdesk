package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"grigdesk.local/tools/utilities/factory/internal/hooks"
	"grigdesk.local/tools/utilities/factory/internal/route"
	"grigdesk.local/tools/utilities/factory/internal/state"
)

type DecisionRequest struct {
	LaunchRequest
	Node, Decision, Comment, Reason, Actor, ExpectedStage string
	CommitOnly                                            bool
	Output                                                io.Writer
	Visit, StopHash, AnswerFile                           string
}

// Decide открывает exact попытку и разделяет короткую мутацию и дальнейший запуск.
// Gate --commit-only не запускает подготовку, разведку или исполнителя.
func Decide(ctx context.Context, input DecisionRequest) (int, error) {
	lock, rc, err := input.Store.LockOrchestrator(input.Task)
	if err != nil {
		if input.Mode == "gate" && rc == 73 {
			writeRouteLog(input.LaunchRequest, "gate CAS не принят (код 75)")
			return 75, fmt.Errorf("%w: gate CAS не принят (код 75)", err)
		}
		return rc, err
	}
	rc, err = decideLocked(ctx, input)
	_ = lock.Close()
	if rc != 0 || err != nil || input.Mode != "gate" || input.CommitOnly {
		return rc, err
	}
	next := input.LaunchRequest
	next.Mode = "resume"
	return Launch(ctx, next)
}

func decideLocked(ctx context.Context, input DecisionRequest) (int, error) {
	attempt, err := input.Store.ReadAttempt(input.Task, input.Attempt)
	if err != nil {
		return projectResult(err)
	}
	if attempt.Profile != input.Profile || attempt.RoutesDir != input.RoutesDir ||
		(input.Mode != "recover" && attempt.Terminal != "") {
		return 75, fmt.Errorf("решение адресовано другой попытке")
	}
	if input.Mode == "bootstrap-answer" {
		answer, err := readLaunchInput(input.AnswerFile, 256*1024)
		if err != nil {
			return 78, err
		}
		receipt, _, err := input.Store.AnswerBootstrap(attempt, state.BootstrapDecision{
			VisitID: input.Visit, StopHash: input.StopHash, Answer: string(answer),
		})
		if err == nil && input.Output != nil {
			err = json.NewEncoder(input.Output).Encode(receipt)
		}
		return projectResult(err)
	}
	if input.Mode == "recover" {
		return recoverAttempt(ctx, input, attempt)
	}
	reader, err := route.NewBundleReader(attempt.RoutesDir, attempt.Profile)
	if err != nil {
		return 78, err
	}
	bundle, err := reader.ReadRoute(attempt.RouteID, attempt.RouteHash)
	if err != nil {
		return 78, err
	}
	e := execution{request: input.LaunchRequest, attempt: attempt, bundle: bundle}
	switch input.Mode {
	case "gate":
		return e.commitGate(input)
	case "goto":
		return e.rewind(input)
	case "abandon":
		return e.abandon(ctx, input)
	default:
		return 78, fmt.Errorf("решение %s не поддерживается", input.Mode)
	}
}

func sequenceHash(raw string) (int64, string) {
	sequence, hash, _ := strings.Cut(raw, ":")
	number, _ := strconv.ParseInt(sequence, 10, 64)
	return number, hash
}

func (e execution) commitGate(input DecisionRequest) (int, error) {
	node := e.findNode(input.Node)
	key, _ := node["runKey"].(string)
	decisionKey := map[string]string{
		"gate_plan": "PLAN_DECISION", "gate_cause": "CAUSE_DECISION", "gate_accept": "ACCEPTANCE_DECISION",
	}[input.Node]
	if node["executor"] != "gate" || decisionKey == "" || key == "" {
		return 78, fmt.Errorf("неизвестный gate node")
	}
	reason := ""
	if input.Decision == "rejected" {
		reason = input.Comment
		if err := e.validateGateFeedback(input.Node, reason); err != nil {
			return 78, err
		}
	}
	sequence, head := sequenceHash(input.ExpectedStage)
	next, replay, err := input.Store.CommitGate(state.StageCommit{
		Task: input.Task, Attempt: input.Attempt, Node: input.Node, Outcome: input.Decision,
		ExpectedSequence: sequence, ExpectedHead: head, Reason: reason,
	})
	if err != nil {
		rc, err := projectResult(err)
		writeRouteLog(input.LaunchRequest, fmt.Sprintf("gate CAS не принят (код %d)", rc))
		return rc, err
	}
	digest := gateCommentDigest(input.Comment)
	fields := []state.ProjectionField{
		{Key: key, Value: input.Decision}, {Key: key + "_COMMENT", Value: digest},
		{Key: decisionKey, Value: input.Decision}, {Key: decisionKey + "_COMMENT", Value: digest},
		{Key: "STALLED_HUMAN", Value: "0"},
	}
	if next.State == "stopped" && next.Stop == "human" {
		fields[len(fields)-1].Value = "1"
	}
	if err := e.project(fields...); err != nil {
		return projectResult(err)
	}
	if !replay {
		writeRouteLog(input.LaunchRequest, "gate "+input.Node+"="+input.Decision+" зафиксирован")
	}
	return 0, nil
}

func (e execution) validateGateFeedback(id, reason string) error {
	if reason == "" {
		return nil
	}
	edge, err := e.bundle.Transition(id, "rejected", "")
	if err != nil {
		return err
	}
	action, _ := edge["action"].(map[string]any)
	for _, field := range []string{"rewind", "next"} {
		target, _ := action[field].(string)
		if target != "" && e.findNode(target)["executor"] != "agent" {
			return fmt.Errorf("комментарий rejected нельзя доставить: %s ведёт в %s, нужен agent",
				field, target)
		}
	}
	return nil
}

func gateCommentDigest(raw string) string {
	text := []rune(strings.Join(strings.Fields(raw), " "))
	if len(text) <= 300 {
		return string(text)
	}
	return strings.TrimSpace(string(text[:299])) + "…"
}

func (e execution) rewind(input DecisionRequest) (int, error) {
	sequence, hash := sequenceHash(input.ExpectedStage)
	_, err := input.Store.RewindStage(state.RewindRequest{
		Task: input.Task, Attempt: input.Attempt, Node: input.Node, Reason: input.Reason, Actor: input.Actor,
		ExpectedSequence: sequence, ExpectedHead: hash,
	})
	if err != nil {
		return projectResult(err)
	}
	reset, err := e.bundle.RewindReset(input.Node)
	if err != nil {
		return 78, err
	}
	fields := []state.ProjectionField{
		{Key: "STALLED_HUMAN", Value: "0"}, {Key: "RESULT", Value: "human-rewind"},
	}
	for _, val := range reset {
		current, _ := val.(string)
		key, _ := e.findNode(current)["runKey"].(string)
		if key != "" {
			fields = append(fields, state.ProjectionField{Key: key, Value: "pending"},
				state.ProjectionField{Key: key + "_COMMENT", Value: ""})
		}
	}
	if err := e.project(fields...); err != nil {
		return projectResult(err)
	}
	writeRouteLog(input.LaunchRequest, "курсор возвращён на "+input.Node)
	_, err = fmt.Fprintln(input.Output, "rewound", input.Node)
	return projectResult(err)
}

func (e execution) abandon(ctx context.Context, input DecisionRequest) (int, error) {
	if err := e.initializeInvocation(); err != nil {
		return 78, err
	}
	workspace, rc, err := hooks.ReadWorkspace(ctx, e.invoke, input.Task)
	if err != nil {
		return rc, err
	}
	if rc, err := e.checkNoActiveTransaction(); err != nil {
		return rc, err
	}
	if workspace.Mode == "shared" {
		if err := input.Store.SharedLease(e.attempt, workspace.Resources, "require"); err != nil {
			return 73, err
		}
	}
	if err := input.Store.FinishAttempt(e.attempt, "abandoned", input.Reason); err != nil {
		return projectResult(err)
	}
	if err := e.project(state.ProjectionField{Key: "STALLED_HUMAN", Value: "1"},
		state.ProjectionField{Key: "RESULT", Value: "abandoned"}); err != nil {
		return projectResult(err)
	}
	if workspace.Mode == "shared" {
		if err := input.Store.SharedLease(e.attempt, workspace.Resources, "release"); err != nil {
			return 75, err
		}
	}
	writeRouteLog(input.LaunchRequest, "attempt "+input.Attempt+" закрыт терминалом abandoned")
	_, err = fmt.Fprintln(input.Output, "abandoned", input.Attempt)
	return projectResult(err)
}

// writeRouteLog дописывает прежний журнал стадии, который читает GrigDesk.
// Текст остаётся витриной: он не меняет закреплённые события и результат CAS.
func writeRouteLog(input LaunchRequest, message string) {
	dir := filepath.Join(input.Store.StateDir, "logs")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return
	}
	physical, err := filepath.EvalSymlinks(dir)
	if err != nil || physical != dir {
		return
	}
	log := filepath.Join(dir, "t"+input.Task+".stages.log")
	flags := os.O_WRONLY | os.O_CREATE | os.O_APPEND | syscall.O_NOFOLLOW | syscall.O_NONBLOCK
	file, err := os.OpenFile(log, flags, 0600)
	if err != nil {
		return
	}
	defer file.Close()
	_, _ = fmt.Fprintf(file, "%s [t%s] route: %s\n", time.Now().Format(time.DateTime), input.Task, message)
}
