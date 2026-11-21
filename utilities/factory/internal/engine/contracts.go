package engine

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"grigdesk.local/tools/utilities/factory/internal/hooks"
	"grigdesk.local/tools/utilities/factory/internal/route"
)

type contractPaths struct {
	ticket, project, scope      string
	strategy, diagnosis, signal string
	actions, targets            []string
}

// pinContracts закрепляет профильный контракт в принятом формате attempt artifacts.
// Повтор читает ticket и проверяет, что hooks всё ещё описывают те же рабочие деревья.
func (e *execution) pinContracts(delivery, instrumentation string) (int, error) {
	r := e.request
	create := r.Mode == "start"
	manifest := profileManifest(e.workspace, false)
	if !create {
		prior, _, err := r.Store.AttemptArtifact(e.attempt, "profile-contract.tsv", nil, false)
		if err != nil {
			return 78, err
		}
		if bytes.Contains(prior, []byte("\nrepo\t")) {
			for line := range strings.SplitSeq(string(prior), "\n") {
				if strings.HasPrefix(line, "repo\t") && strings.Count(line, "\t") == 3 {
					manifest = profileManifest(e.workspace, true)
					break
				}
			}
		}
	}
	_, _, err := r.Store.AttemptArtifact(e.attempt, "profile-contract.tsv", manifest, create)
	if err != nil {
		return projectResult(err)
	}
	_, e.artifacts.project, err = r.Store.AttemptArtifact(e.attempt, "project-context.json",
		e.workspace.Project, create)
	if err != nil {
		return projectResult(err)
	}
	var ticket []byte
	if create {
		ticket, err = readLaunchInput(r.Ticket, 256*1024)
		if err != nil {
			return 78, err
		}
	}
	_, e.artifacts.ticket, err = r.Store.AttemptArtifact(e.attempt, "ticket.json", ticket, create)
	if err != nil {
		return projectResult(err)
	}
	if err := route.ValidateContextTicket(e.artifacts.ticket, r.Task); err != nil {
		return 78, err
	}
	if rc, err := e.pinDiagnosis(create); err != nil {
		return rc, err
	}
	if rc, err := e.pinScope(create, instrumentation); err != nil {
		return rc, err
	}
	return e.pinDelivery(create, delivery)
}

func readLaunchInput(path string, limit int64) ([]byte, error) {
	if err := hooks.CheckFile(path, "вход попытки"); err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(raw)) > limit {
		return nil, fmt.Errorf("вход попытки превышает лимит или недоступен")
	}
	return raw, nil
}

func profileManifest(w hooks.Workspace, legacy bool) []byte {
	var value strings.Builder
	fmt.Fprintf(&value, "schema\t1\nrepos-mode\tgeneric\nworkspace-mode\t%s\n", w.Mode)
	if w.Stand != "" {
		fmt.Fprintf(&value, "stand-mode\t%s\n", w.Stand)
	}
	owner := "task"
	if w.Mode == "shared" {
		owner = "external"
	}
	fmt.Fprintf(&value, "stand-ownership\t%s\nsource-branch\t%s\ncontainer\t%s\nservice-host\t%s\n",
		owner, w.Repositories[0].Branch, w.Container, w.Host)
	if w.Mode == "shared" {
		fmt.Fprintf(&value, "frontend-port\t%s\napi-port\t%s\n", w.FrontPort, w.APIPort)
		for _, resource := range w.Resources {
			fmt.Fprintf(&value, "exclusive-resource\t%s\n", resource)
		}
	}
	for _, repo := range w.Repositories {
		fmt.Fprintf(&value, "repo\t%s\t%s\t%s", repo.Name, repo.Source, repo.Worktree)
		if !legacy {
			fmt.Fprintf(&value, "\t%s", repo.Branch)
		}
		value.WriteByte('\n')
	}
	return []byte(value.String())
}

func (e *execution) pinDiagnosis(create bool) (int, error) {
	r := e.request
	var expected []byte
	if create && (r.Diagnosis != "" || r.Signal != "") {
		kind, signal := r.Diagnosis, r.Signal
		if kind == "" {
			kind = "functional"
		}
		if signal == "" {
			signal = "unspecified"
		}
		expected = fmt.Appendf(nil, "KIND=%s\nSIGNAL=%s\n", kind, signal)
	}
	raw, _, err := r.Store.AttemptArtifact(e.attempt, "diagnosis.env", expected, expected != nil)
	if os.IsNotExist(err) {
		return 0, nil
	}
	if err != nil {
		return projectResult(err)
	}
	fields, err := parseDescriptor(raw)
	e.artifacts.diagnosis, e.artifacts.signal = fields["KIND"], fields["SIGNAL"]
	return projectResult(err)
}

func (e *execution) pinScope(create bool, mode string) (int, error) {
	spec := e.request.Scope
	if mode != "explicit" {
		if len(spec) != 0 {
			return 2, fmt.Errorf("маршрут не принимает явный scope инструментации")
		}
		_, _, err := e.request.Store.AttemptArtifact(e.attempt, "instrumentation-scope.tsv", nil, false)
		if !os.IsNotExist(err) {
			return 78, fmt.Errorf("неожиданный закреплённый scope инструментации")
		}
		return 0, nil
	}
	var rows []string
	for _, entry := range spec {
		repo, relative, ok := strings.Cut(entry, ":")
		if !ok || !e.knownRepo(repo) || !validScopePath(relative) {
			return 2, fmt.Errorf("неверный путь в scope инструментации")
		}
		rows = append(rows, repo+"\t"+relative)
	}
	if create && len(rows) == 0 {
		return 78, fmt.Errorf("маршрут требует scope инструментации")
	}
	var expected []byte
	if create {
		expected = sortedRows(rows)
	}
	_, path, err := e.request.Store.AttemptArtifact(e.attempt, "instrumentation-scope.tsv", expected, create)
	e.artifacts.scope = path
	return projectResult(err)
}

func validScopePath(name string) bool {
	if name == "" || name == "." || name == ".." || filepath.Clean(name) != name || filepath.IsAbs(name) ||
		strings.ContainsAny(name, "\t\n\r\\") {
		return false
	}
	for part := range strings.SplitSeq(name, "/") {
		if part == ".." || part == ".env" || part == ".git" || part == ".slot" ||
			strings.HasPrefix(part, ".env.") {
			return false
		}
	}
	return true
}

func (e execution) knownRepo(name string) bool {
	for _, repo := range e.workspace.Repositories {
		if repo.Name == name {
			return true
		}
	}
	return false
}

var deliveryBranch = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$`)

// pinDelivery сохраняет действия и branch targets только для закреплённого SHIP.
// Поддерживаются прежние строки legacy и opt-in стратегии профиля.
func (e *execution) pinDelivery(create bool, mode string) (int, error) {
	r := e.request
	if mode == "disabled" {
		if len(r.Targets) > 0 || r.TaskComment {
			return 2, fmt.Errorf("маршрут без SHIP не принимает параметры доставки")
		}
		_, _, err := r.Store.AttemptArtifact(e.attempt, "delivery.tsv", nil, false)
		if !os.IsNotExist(err) {
			return 78, fmt.Errorf("маршрут без SHIP имеет неожиданный delivery pin")
		}
		return 0, nil
	}
	var expected []byte
	if create {
		rows, rc, err := e.deliveryRows()
		if err != nil {
			return rc, err
		}
		expected = sortedRows(rows)
	}
	raw, _, err := r.Store.AttemptArtifact(e.attempt, "delivery.tsv", expected, create)
	if err != nil {
		return projectResult(err)
	}
	for line := range strings.SplitSeq(strings.TrimSuffix(string(raw), "\n"), "\n") {
		kind, value, _ := strings.Cut(line, "\t")
		switch kind {
		case "strategy":
			e.artifacts.strategy = value
		case "action":
			e.artifacts.actions = append(e.artifacts.actions, value)
		case "target":
			if !e.validTarget(value) {
				return 78, fmt.Errorf("неверный target delivery pin")
			}
			e.artifacts.targets = append(e.artifacts.targets, value)
		default:
			return 78, fmt.Errorf("неизвестное поле delivery pin")
		}
	}
	return 0, nil
}

func (e execution) deliveryRows() ([]string, int, error) {
	r, strategy := e.request, e.workspace.Delivery
	if len(r.Targets) == 0 {
		return nil, 2, fmt.Errorf("применимый SHIP требует явные delivery targets")
	}
	actions := []string{"commit", "push", "pull-request"}
	var rows []string
	switch strategy {
	case "":
		if r.TaskComment {
			actions = append(actions, "task-comment")
		}
	case "commit":
		actions = []string{"commit"}
	case "merge":
		actions = []string{"commit", "merge"}
	case "pull-request":
	default:
		return nil, 78, fmt.Errorf("неизвестная стратегия доставки")
	}
	if strategy != "" {
		if r.TaskComment {
			return nil, 78, fmt.Errorf("opt-in стратегия не допускает task-comment")
		}
		rows = append(rows, "strategy\t"+strategy)
	}
	for _, action := range actions {
		rows = append(rows, "action\t"+action)
	}
	for _, target := range r.Targets {
		if !e.validTarget(target) {
			return nil, 2, fmt.Errorf("неверная ветка delivery target")
		}
		rows = append(rows, "target\t"+target)
	}
	return rows, 0, nil
}

func (e execution) validTarget(value string) bool {
	name, branch, ok := strings.Cut(value, "=")
	return ok && e.knownRepo(name) && deliveryBranch.MatchString(branch) && !strings.Contains(branch, "..") &&
		!strings.Contains(branch, "//") && !strings.Contains(branch, "@{") &&
		!strings.HasSuffix(branch, "/") && !strings.HasSuffix(branch, ".") &&
		!strings.HasSuffix(branch, ".lock")
}

func sortedRows(rows []string) []byte {
	slices.Sort(rows)
	return []byte(strings.Join(slices.Compact(rows), "\n") + "\n")
}
