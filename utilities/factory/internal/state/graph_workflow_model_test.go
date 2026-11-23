//go:build unix

package state

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"

	"grigdesk.local/tools/utilities/factory/internal/graphworkflow"
	"grigdesk.local/tools/utilities/factory/internal/host"
)

type graphModelChildRequest struct {
	Command      string              `json:"command"`
	ID           string              `json:"id"`
	NodeID       string              `json:"nodeId"`
	Generation   uint64              `json:"generation"`
	ClaimID      string              `json:"claimId"`
	OwnerNonce   string              `json:"ownerNonce"`
	OwnerPid     int                 `json:"ownerPid"`
	PpidOverride int                 `json:"ppidOverride"`
	ScopePid     int                 `json:"scopePid"`
	CloseKind    string              `json:"closeKind"`
	Rows         []graphworkflow.Row `json:"rows"`
	ErrorCode    string              `json:"errorCode"`
	Now          int64               `json:"now"`
}

// runGraphModelRPC выполняет одну модельную команду от имени detached-владельца.
// Драйвер живёт только в тестовом бинарнике и не диспетчеризует провайдер.
func runGraphModelRPC() int {
	raw, _ := io.ReadAll(io.LimitReader(os.Stdin, 2<<20))
	var request graphModelChildRequest
	if err := json.Unmarshal(raw, &request); err != nil {
		return 65
	}
	store := Store{ControlDir: os.Getenv("FACTORY_CONTROL_ROOT")}
	var data any
	var err error
	switch request.Command {
	case "model-open":
		data, err = store.ModelOpen(request.ID, request.NodeID, request.Generation,
			request.ClaimID, request.OwnerNonce, request.OwnerPid, request.Now)
	case "model-admit":
		data, err = store.ModelAdmit(request.ID, request.NodeID, request.Generation,
			request.ClaimID, request.OwnerNonce, request.ScopePid, request.Now)
	case "model-stop":
		err = store.ModelStop(request.ID, request.ClaimID, request.OwnerNonce)
		data = map[string]any{"stopped": true}
	case "model-close":
		var settlement *graphworkflow.Settlement
		if request.Rows != nil || request.ErrorCode != "" {
			settlement = &graphworkflow.Settlement{
				RunID: request.ID, NodeID: request.NodeID, Generation: request.Generation,
				ClaimID: request.ClaimID, Rows: request.Rows, ErrorCode: request.ErrorCode,
			}
		}
		data, err = store.ModelClose(request.ID, request.NodeID, request.Generation,
			request.ClaimID, request.OwnerNonce, request.CloseKind, settlement, request.Now)
	default:
		return 65
	}
	if err != nil {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": false, "error": err.Error()})
		return 75
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": true, "data": data})
	return 0
}

// runGraphModelChild — detached-владелец: спавнит provider и RPC отдельными сессиями.
func runGraphModelChild() int {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 2<<20)
	encoder := json.NewEncoder(os.Stdout)
	var provider *exec.Cmd
	for scanner.Scan() {
		var request graphModelChildRequest
		if json.Unmarshal(scanner.Bytes(), &request) != nil {
			continue
		}
		switch request.Command {
		case "spawn-provider":
			provider = exec.Command("sleep", "30")
			provider.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
			if err := provider.Start(); err != nil {
				_ = encoder.Encode(map[string]any{"ok": false, "error": err.Error()})
				continue
			}
			_ = encoder.Encode(map[string]any{"ok": true, "data": map[string]any{"pid": provider.Process.Pid}})
		case "kill-provider":
			if provider != nil {
				_ = provider.Process.Kill()
				_ = provider.Wait()
			}
			_ = encoder.Encode(map[string]any{"ok": true})
		default:
			if request.PpidOverride != 0 {
				request.OwnerPid = request.PpidOverride
			} else {
				request.OwnerPid = os.Getpid()
			}
			if request.Command == "model-admit" && request.ScopePid == 0 && provider != nil {
				request.ScopePid = provider.Process.Pid
			}
			payload, _ := json.Marshal(request)
			rpc := exec.Command(os.Args[0], "-test.run=^$")
			env := make([]string, 0, len(os.Environ())+1)
			for _, entry := range os.Environ() {
				if !strings.HasPrefix(entry, "FACTORY_TEST_GRAPH_MODEL_CHILD=") {
					env = append(env, entry)
				}
			}
			rpc.Env = append(env, "FACTORY_TEST_GRAPH_MODEL_RPC=1")
			rpc.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
			rpc.Stdin = bytes.NewReader(payload)
			out, _ := rpc.Output()
			if len(out) == 0 {
				_ = encoder.Encode(map[string]any{"ok": false, "error": "rpc_silent"})
				continue
			}
			_, _ = os.Stdout.Write(out)
		}
	}
	return 0
}

type graphModelChild struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	scanner *bufio.Scanner
}

func startGraphModelChild(t *testing.T, root string) *graphModelChild {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(os.Environ(), "FACTORY_TEST_GRAPH_MODEL_CHILD=1", "FACTORY_CONTROL_ROOT="+root)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 2<<20)
	return &graphModelChild{cmd: cmd, stdin: stdin, scanner: scanner}
}

func (child *graphModelChild) call(t *testing.T, request graphModelChildRequest) (map[string]any, bool) {
	t.Helper()
	payload, _ := json.Marshal(request)
	if _, err := child.stdin.Write(append(payload, '\n')); err != nil {
		t.Fatal(err)
	}
	if !child.scanner.Scan() {
		t.Fatalf("detached-владелец молчит на %s", request.Command)
	}
	var reply map[string]any
	if err := json.Unmarshal(child.scanner.Bytes(), &reply); err != nil {
		t.Fatalf("неверный ответ владельца: %s", child.scanner.Bytes())
	}
	return reply, reply["ok"] == true
}

func graphModelStartRun(t *testing.T, store Store, templateID, runID string, createdAt int64) {
	t.Helper()
	header, _, err := store.SaveGraphTemplate(templateID, nil, graphParallelTemplate(2))
	if errors.Is(err, ErrConflict) {
		header, _, err = store.ReadGraphTemplate(templateID)
	}
	if err != nil {
		t.Fatal(err)
	}
	request := GraphStartRequest{
		ID: runID, TemplateID: templateID, ExpectedRevision: header.Revision,
		Files: []graphInputFile{{Name: "a.txt", Text: "вход"}},
	}
	if _, err := store.StartGraphRun(request, createdAt); err != nil {
		t.Fatal(err)
	}
}

func TestGraphWorkflowModelOpenRecoversLostReceipt(t *testing.T) {
	root := filepath.Join(t.TempDir(), "control")
	store := Store{ControlDir: root}
	templateID := "a2372fd2-e591-41c8-964a-64d321e3c677"
	runID := "74906bac-48d5-40ce-a6a9-96cbce242146"
	graphModelStartRun(t, store, templateID, runID, 1000)
	claim, err := store.ClaimGraphJob(1000)
	if err != nil || claim.Job == nil {
		t.Fatalf("выдача не получена: %+v %v", claim, err)
	}
	job := claim.Job
	child := startGraphModelChild(t, root)
	open := graphModelChildRequest{
		Command: "model-open", ID: runID, NodeID: job.NodeID, Generation: job.Generation,
		ClaimID: job.ClaimID, OwnerNonce: "n1", Now: 1000,
	}
	first, ok := child.call(t, open)
	if !ok {
		t.Fatalf("model-open не принят: %+v", first)
	}
	replay, ok := child.call(t, open)
	if !ok || !reflect.DeepEqual(first, replay) {
		t.Fatalf("потерянный stdout повторяется побайтно: %+v vs %+v", first, replay)
	}
	other := open
	other.OwnerNonce = "n2"
	if reply, ok := child.call(t, other); ok {
		t.Fatalf("другой nonce той же выдачи отвергается: %+v", reply)
	}
	foreign := open
	foreign.PpidOverride = os.Getpid() + 999999
	foreign.OwnerNonce = "n9"
	if reply, ok := child.call(t, foreign); ok || reply["error"] != "process_exit_unconfirmed" {
		t.Fatalf("чужой PPID даёт process_exit_unconfirmed без резервации: %+v", reply)
	}
	if _, ok := child.call(t, graphModelChildRequest{Command: "spawn-provider"}); !ok {
		t.Fatalf("provider не запущен")
	}
	admit := graphModelChildRequest{
		Command: "model-admit", ID: runID, NodeID: job.NodeID, Generation: job.Generation,
		ClaimID: job.ClaimID, OwnerNonce: "n1", Now: 1000,
	}
	if reply, ok := child.call(t, admit); !ok {
		t.Fatalf("model-admit не принят: %+v", reply)
	}
	if _, ok := child.call(t, graphModelChildRequest{Command: "kill-provider"}); !ok {
		t.Fatalf("provider не остановлен")
	}
	// Scope уже вышел, но живой помощник ещё записывает принятое завершение.
	second, err := store.ClaimGraphJob(1050)
	if err != nil || second.Job == nil {
		t.Fatalf("опрос не должен потерять первую выдачу и может выдать вторую: %+v %v", second, err)
	}
	closeReq := graphModelChildRequest{
		Command: "model-close", ID: runID, NodeID: job.NodeID, Generation: job.Generation,
		ClaimID: job.ClaimID, OwnerNonce: "n1", CloseKind: "scope_exit", Now: 1100,
		Rows: []graphworkflow.Row{},
	}
	if reply, ok := child.call(t, closeReq); !ok {
		t.Fatalf("model-close не принят: %+v", reply)
	}
	_, snapshot, err := store.ReadGraphRun(runID)
	if err != nil || snapshot.Nodes[job.NodeID].Status != "done" || len(snapshot.Nodes[job.NodeID].Rows) != 0 {
		t.Fatalf("результат записан один раз: %+v %v", snapshot.Nodes[job.NodeID], err)
	}

	never := graphModelChildRequest{
		Command: "model-open", ID: runID, NodeID: second.Job.NodeID, Generation: second.Job.Generation,
		ClaimID: second.Job.ClaimID, OwnerNonce: "n3", Now: 1200,
	}
	if reply, ok := child.call(t, never); !ok {
		t.Fatalf("open второй выдачи не принят: %+v", reply)
	}
	if _, err := store.SettleGraphJob(graphworkflow.Settlement{
		RunID: runID, NodeID: second.Job.NodeID, Generation: second.Job.Generation, ClaimID: second.Job.ClaimID,
		Rows: []graphworkflow.Row{{Key: "x", Title: "X", Text: "нельзя"}},
	}, 1250); err == nil {
		t.Fatalf("settle физически открытой выдачи отвергается")
	}
	neverClose := never
	neverClose.Command = "model-close"
	neverClose.CloseKind = "never_spawned"
	neverClose.Now = 1300
	neverClose.ErrorCode = "input_limit"
	if reply, ok := child.call(t, neverClose); !ok {
		t.Fatalf("never_spawned не принят: %+v", reply)
	}
	_, snapshot, err = store.ReadGraphRun(runID)
	if err != nil || snapshot.Nodes[second.Job.NodeID].ErrorCode != "input_limit" {
		t.Fatalf("место освобождено без запуска CLI: %+v %v", snapshot.Nodes[second.Job.NodeID], err)
	}
	third, err := store.ClaimGraphJob(1400)
	if err != nil || third.Job != nil {
		t.Fatalf("постоянная ошибка не создаёт новую выдачу: %+v %v", third, err)
	}
}

func TestGraphWorkflowModelCloseSurvivesBrokenSnapshot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "control")
	store := Store{ControlDir: root}
	templateID := "a2372fd2-e591-41c8-964a-64d321e3c677"
	run1 := "74906bac-48d5-40ce-a6a9-96cbce242146"
	run2 := "b1690525-b349-422c-a165-778def939e5c"
	graphModelStartRun(t, store, templateID, run1, 1000)
	graphModelStartRun(t, store, templateID, run2, 2000)
	claim, err := store.ClaimGraphJob(1000)
	if err != nil || claim.Job == nil || claim.Job.ID != run1 {
		t.Fatalf("выдача первого прогона: %+v %v", claim, err)
	}
	job := claim.Job
	child := startGraphModelChild(t, root)
	open := graphModelChildRequest{
		Command: "model-open", ID: run1, NodeID: job.NodeID, Generation: job.Generation,
		ClaimID: job.ClaimID, OwnerNonce: "n1", Now: 1000,
	}
	if _, ok := child.call(t, open); !ok {
		t.Fatalf("open не принят")
	}
	if _, ok := child.call(t, graphModelChildRequest{Command: "spawn-provider"}); !ok {
		t.Fatalf("provider не запущен")
	}
	admit := open
	admit.Command = "model-admit"
	if _, ok := child.call(t, admit); !ok {
		t.Fatalf("admit не принят")
	}
	if _, ok := child.call(t, graphModelChildRequest{Command: "kill-provider"}); !ok {
		t.Fatalf("provider не остановлен")
	}
	runPath := filepath.Join(root, "graph-workflows", "runs", run1+".json")
	if err := os.WriteFile(runPath, []byte("повреждённый снимок"), 0600); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(runPath)
	shaBefore := sha256.Sum256(before)
	closeReq := graphModelChildRequest{
		Command: "model-close", ID: run1, NodeID: job.NodeID, Generation: job.Generation,
		ClaimID: job.ClaimID, OwnerNonce: "n1", CloseKind: "scope_exit", Now: 2000,
		Rows: []graphworkflow.Row{{Key: "r1", Title: "R", Text: "готово", Sources: job.Rows[0].Sources}},
	}
	if reply, ok := child.call(t, closeReq); !ok {
		t.Fatalf("close поверх повреждённого снимка фиксирует квитанцию: %+v", reply)
	}
	after, _ := os.ReadFile(runPath)
	shaAfter := sha256.Sum256(after)
	if hex.EncodeToString(shaBefore[:]) != hex.EncodeToString(shaAfter[:]) {
		t.Fatalf("повреждённые байты сохранены побайтно")
	}
	runs, _, err := store.ListGraphRuns("")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, header := range runs {
		if header.ID == run1 && header.Status == "unavailable" && header.ErrorCode == "graph_broken" && header.Revision == 0 {
			found = true
		}
	}
	if !found {
		t.Fatalf("история показывает повреждённый прогон: %+v", runs)
	}
	paused, err := store.ClaimGraphJob(2000)
	if err != nil || paused.Job != nil || paused.NextWakeAt != 2000+graphFaultHorizon {
		t.Fatalf("до горизонта новые выдачи ждут: %+v %v", paused, err)
	}
	freed, err := store.ClaimGraphJob(2000 + graphFaultHorizon + 1)
	if err != nil || freed.Job == nil || freed.Job.ID != run2 {
		t.Fatalf("после горизонта слот получает здоровый прогон: %+v %v", freed, err)
	}
	healthy := freed.Job
	err = store.withGraphWorkflowRoot(true, func(root *os.Root) error {
		index, err := graphActiveAt(root)
		if err != nil {
			return err
		}
		graphPutReservation(&index, &graphReservation{
			ID: run2, NodeID: healthy.NodeID, Generation: healthy.Generation, ClaimID: healthy.ClaimID,
			OwnerNonce: "nx", Phase: "closing", CloseKind: "scope_exit", ClosedAt: healthy.ExpiresAt - 61_000,
			BootID: "previous-boot", ExpiresAt: healthy.ExpiresAt,
			Settlement: &graphworkflow.Settlement{
				RunID: run2, NodeID: healthy.NodeID, Generation: healthy.Generation, ClaimID: healthy.ClaimID,
				Rows: []graphworkflow.Row{{Key: "r2", Title: "R2", Text: "готово", Sources: healthy.Rows[0].Sources}},
			},
		})
		return publishGraphActive(root, index)
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ClaimGraphJob(healthy.ExpiresAt + 1000); err != nil {
		t.Fatal(err)
	}
	_, snapshot, err := store.ReadGraphRun(run2)
	if err != nil || snapshot.Nodes[healthy.NodeID].Status != "done" {
		t.Fatalf("потерянная квитанция закрытия доводится reconcile: %+v %v события %+v", snapshot.Nodes[healthy.NodeID], err, snapshot.Events)
	}
	if _, err := store.ClaimGraphJob(healthy.ExpiresAt + 1000); err != nil {
		t.Fatal(err)
	}
	_, snapshot, err = store.ReadGraphRun(run2)
	if err != nil {
		t.Fatal(err)
	}
	attempts := 0
	for _, event := range snapshot.Events {
		if event.NodeID == healthy.NodeID && event.Kind == "settle" {
			attempts++
		}
	}
	if attempts != 1 {
		t.Fatalf("reconcile записывает результат ровно один раз: %d", attempts)
	}
}

func TestGraphWorkflowModelReservationRetiresPreviousBoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "control")
	store := Store{ControlDir: root}
	templateID := "a2372fd2-e591-41c8-964a-64d321e3c677"
	bootValue := "11111111-1111-4111-8111-111111111111"
	var bootErr error
	original := host.CurrentBootID
	host.CurrentBootID = func() (string, error) { return bootValue, bootErr }
	t.Cleanup(func() { host.CurrentBootID = original })

	ids := []string{
		"74906bac-48d5-40ce-a6a9-96cbce242146",
		"b1690525-b349-422c-a165-778def939e5c",
		"5f820c44-a351-4932-949c-4b970e81dbc8",
		"d11dce6a-b7cc-4654-96b4-3ea48ed46a81",
		"a2372fd2-e591-41c8-964a-64d321e3c677",
	}
	for index, id := range ids {
		graphModelStartRun(t, store, templateID, id, int64(1000*(index+1)))
	}
	jobs := make([]*GraphClaimJob, 0, 4)
	for index := 0; index < 4; index++ {
		claim, err := store.ClaimGraphJob(1000)
		if err != nil || claim.Job == nil {
			t.Fatalf("выдача %d не получена: %+v %v", index, claim, err)
		}
		jobs = append(jobs, claim.Job)
	}
	fake := host.ProcessIdentity{PID: 999999, PPID: 1, Group: 999999, Session: 999999, UID: os.Geteuid(), Start: "1", Boot: bootValue}
	err := store.withGraphWorkflowRoot(true, func(root *os.Root) error {
		index, err := graphActiveAt(root)
		if err != nil {
			return err
		}
		for _, job := range jobs {
			graphPutReservation(&index, &graphReservation{
				ID: job.ID, NodeID: job.NodeID, Generation: job.Generation, ClaimID: job.ClaimID,
				OwnerNonce: "boot", OwnerIdentity: fake, BootID: bootValue, ExpiresAt: job.ExpiresAt,
				Phase: "admitted", Scope: &host.TreeOwner{Leader: fake},
			})
		}
		return publishGraphActive(root, index)
	})
	if err != nil {
		t.Fatal(err)
	}
	if other, err := store.ClaimGraphJob(1000); err != nil || other.Job == nil || other.Job.ID != ids[2] {
		t.Fatalf("чужие резервации не задерживают независимую выдачу: %+v %v", other, err)
	}
	bootValue = "22222222-2222-4222-8222-222222222222"
	retired, err := store.ClaimGraphJob(1000)
	if err != nil || retired.Job == nil {
		t.Fatalf("после смены загрузки сохраняется возможность выдачи: %+v %v", retired, err)
	}
	for _, job := range jobs {
		_, snapshot, err := store.ReadGraphRun(job.ID)
		if err != nil || snapshot.Nodes[job.NodeID].ErrorCode != "interrupted" {
			t.Fatalf("прежняя резервация закрыта interrupted: %+v %v", snapshot.Nodes[job.NodeID], err)
		}
	}

	bootErr = errors.New("probe недоступен")
	probe, err := store.ClaimGraphJob(1000)
	if err != nil {
		t.Fatal(err)
	}
	_ = probe
	err = store.withGraphWorkflowRoot(true, func(root *os.Root) error {
		index, err := graphActiveAt(root)
		if err != nil {
			return err
		}
		graphPutReservation(&index, &graphReservation{
			ID: retired.Job.ID, NodeID: retired.Job.NodeID, Generation: retired.Job.Generation, ClaimID: retired.Job.ClaimID,
			OwnerNonce: "probe", OwnerIdentity: fake, BootID: "22222222-2222-4222-8222-222222222222",
			ExpiresAt: retired.Job.ExpiresAt, Phase: "admitted", Scope: &host.TreeOwner{Leader: fake},
		})
		return publishGraphActive(root, index)
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ClaimGraphJob(1000); err != nil {
		t.Fatal(err)
	}
	err = store.withGraphWorkflowRoot(false, func(root *os.Root) error {
		index, err := graphActiveAt(root)
		if err != nil {
			return err
		}
		if graphReservationFor(&index, retired.Job.ClaimID) == nil {
			t.Fatalf("ошибка probe сохраняет резервацию")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestGraphWorkflowModelCloseUnconfirmedKeepsSlot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "control")
	store := Store{ControlDir: root}
	templateID := "a2372fd2-e591-41c8-964a-64d321e3c677"
	runID := "74906bac-48d5-40ce-a6a9-96cbce242146"
	graphModelStartRun(t, store, templateID, runID, 1000)
	claim, err := store.ClaimGraphJob(1000)
	if err != nil || claim.Job == nil {
		t.Fatalf("выдача не получена: %+v %v", claim, err)
	}
	job := claim.Job
	provider := exec.Command("sleep", "30")
	provider.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := provider.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = provider.Process.Kill()
		_ = provider.Wait()
	})
	scope, err := host.CaptureTree(provider.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	boot, err := host.CurrentBootID()
	if err != nil {
		t.Fatal(err)
	}
	err = store.withGraphWorkflowRoot(true, func(root *os.Root) error {
		index, err := graphActiveAt(root)
		if err != nil {
			return err
		}
		graphPutReservation(&index, &graphReservation{
			ID: runID, NodeID: job.NodeID, Generation: job.Generation, ClaimID: job.ClaimID,
			OwnerNonce: "live", OwnerIdentity: scope.Leader, BootID: boot, ExpiresAt: job.ExpiresAt,
			Phase: "admitted", Scope: &scope,
		})
		return publishGraphActive(root, index)
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.ModelClose(runID, job.NodeID, job.Generation, job.ClaimID, "live", "scope_exit", nil, 1100)
	if err == nil || err.Error() != "process_exit_unconfirmed" {
		t.Fatalf("живой scope даёт видимый отказ: %v", err)
	}
	if _, err := store.ClaimGraphJob(1100); err != nil {
		t.Fatal(err)
	}
	err = store.withGraphWorkflowRoot(false, func(root *os.Root) error {
		index, err := graphActiveAt(root)
		if err != nil {
			return err
		}
		if graphReservationFor(&index, job.ClaimID) == nil {
			t.Fatalf("неподтверждённый выход удерживает своё место")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
