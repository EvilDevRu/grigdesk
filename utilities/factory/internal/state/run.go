package state

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"grigdesk.local/tools/utilities/factory/internal/host"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

type RunIdentity struct {
	Task, Attempt, Stage, ID string
	Epoch                    uint64
	LoopRole, Node, Profile  string
}

type RunSnapshot struct {
	Identity                        RunIdentity
	State, Result, Comment, Verdict string
}

var runStagePattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)
var runIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,160}$`)

const runRecordLimit = 128 * 1024

// Valid проверяет имена до обращения к control, registry или каталогу запросов.
// Точка и две точки исключаются как специальные имена компонентов пути.
func (id RunIdentity) Valid() bool {
	return taskPattern.MatchString(id.Task) && attemptPattern.MatchString(id.Attempt) &&
		runStagePattern.MatchString(id.Stage) && runIDPattern.MatchString(id.ID) &&
		id.ID != "." && id.ID != ".." && id.Epoch > 0 &&
		(id.Node == "" || runnerNode.MatchString(id.Node))
}

func (id RunIdentity) stageRunnerIdentity() StageRunnerIdentity {
	return StageRunnerIdentity{Task: id.Task, Attempt: id.Attempt, Profile: id.Profile,
		Node: id.Node, Stage: id.Stage}
}

type runHandle struct {
	task    *taskState
	root    *os.Root
	name    string
	project *projectionWriter
}

// openRun проверяет физическую активную попытку, независимо от state-проекции.
// Порядок lock для writers совпадает с обновлением проекции попытки.
func (s Store) openRun(id RunIdentity, write bool) (*runHandle, int, error) {
	if !id.Valid() {
		return nil, 2, fmt.Errorf("неверная identity запуска")
	}
	if rootsOverlap(s.ControlDir, s.StateDir) {
		return nil, 78, fmt.Errorf("корни control и state пересекаются")
	}
	task, err := s.openTask(id.Task, write)
	if err != nil {
		return nil, 78, err
	}
	active, err := task.activeAttempt(id.Task)
	if err != nil || active != id.Attempt {
		task.close()
		return nil, 73, fmt.Errorf("попытка запуска сменилась")
	}
	handle := &runHandle{task: task, name: filepath.Join("runs", "t"+id.Task, id.Stage+".active")}
	if write {
		handle.project, err = s.lockProjection(id.Task)
		if err != nil {
			handle.close()
			return nil, 78, err
		}
	}
	handle.root, err = openControl(s.ControlDir, false)
	if err != nil {
		handle.close()
		return nil, 78, err
	}
	for _, dir := range []string{"runs", filepath.Dir(handle.name)} {
		if err := ensurePrivateDirectory(handle.root, dir, write); err != nil {
			handle.close()
			if !write && errors.Is(err, os.ErrNotExist) {
				return nil, 73, fmt.Errorf("запуск отсутствует")
			}
			return nil, 78, err
		}
	}
	return handle, 0, nil
}

func (h *runHandle) close() {
	if h.root != nil {
		h.root.Close()
	}
	if h.project != nil {
		h.project.close()
	}
	h.task.close()
}

func rootsOverlap(first, second string) bool {
	if !filepath.IsAbs(first) || !filepath.IsAbs(second) ||
		filepath.Clean(first) != first || filepath.Clean(second) != second {
		return true
	}
	return host.PathsOverlap(first, second)
}

// BeginRun создаёт новое случайное право в точной эпохе.
// На диск попадает хэш capability, а действующая попытка проверяется под lock.
func (s Store) BeginRun(id RunIdentity) (string, int, error) {
	return s.beginRun(&id, false)
}

// NextRun выбирает эпоху и новое право в одной критической секции.
// Предыдущий token не может подтвердить результат новой попытки запуска.
func (s Store) NextRun(task, attempt, node, stage, role string) (RunIdentity, string, int, error) {
	var value [16]byte
	_, _ = rand.Read(value[:])
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	id := RunIdentity{Task: task, Attempt: attempt, Stage: stage, ID: "r" + hex.EncodeToString(value[:]),
		Epoch: 1, LoopRole: role, Node: node}
	token, rc, err := s.beginRun(&id, true)
	return id, token, rc, err
}

func (s Store) beginRun(id *RunIdentity, allocate bool) (string, int, error) {
	if id.LoopRole != "" && id.LoopRole != "lead" && id.LoopRole != "worker" {
		return "", 2, fmt.Errorf("неверная роль узла цикла")
	}
	handle, rc, err := s.openRun(*id, true)
	if err != nil {
		return "", rc, err
	}
	defer handle.close()
	attempt, err := handle.task.readAttempt(id.Task, id.Attempt)
	if err != nil || attempt.Terminal != "" || attempt.RouteID == "" {
		return "", 78, fmt.Errorf("запуск требует действующего закреплённого маршрута")
	}
	if id.Node != "" {
		id.Profile = attempt.Profile
	}
	fields, err := handle.readRecord()
	var current uint64
	if err == nil {
		var parseErr error
		current, parseErr = strconv.ParseUint(fields["EPOCH"], 10, 64)
		if parseErr != nil || current == 0 {
			return "", 78, fmt.Errorf("действующая эпоха повреждена")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", 78, err
	}
	if allocate {
		epoch, err := handle.projectEpoch(id.Stage)
		if err != nil || max(current, epoch) >= 9007199254740991 {
			return "", 78, fmt.Errorf("счётчик эпох недоступен или исчерпан")
		}
		id.Epoch = max(current, epoch) + 1
	} else if current >= id.Epoch {
		return "", 73, fmt.Errorf("действующая эпоха уже опубликована")
	}

	token := rand.Text()
	run := RunSnapshot{Identity: *id, State: "active"}
	if err := handle.writeRecord(run, digestOf([]byte(token))); err != nil {
		return "", 78, err
	}
	fieldsToProject := []ProjectionField{
		{"RUN_PROTOCOL", "2"}, {id.Stage, "running"}, {"ACTIVE_RUN_" + id.Stage, id.ID},
		{"ACTIVE_EPOCH_" + id.Stage, strconv.FormatUint(id.Epoch, 10)},
	}
	if err := handle.project.write(fieldsToProject); err != nil {
		return "", 78, err
	}
	return token, 0, nil
}

func (h *runHandle) projectEpoch(stage string) (uint64, error) {
	_, raw, err := findProjection(h.project.root, h.project.name)
	if err != nil {
		return 0, err
	}
	var epoch uint64
	key := "ACTIVE_EPOCH_" + stage
	for row := range strings.SplitSeq(string(raw), "\n") {
		name, value, _ := strings.Cut(row, "=")
		if name == key {
			epoch, _ = strconv.ParseUint(value, 10, 64)
		}
	}
	return epoch, nil
}

// ReadRun читает только защищённую запись текущей попытки и эпохи.
// Устаревшая identity возвращает код конфликта без ремонта проекции.
func (s Store) ReadRun(id RunIdentity) (RunSnapshot, int, error) {
	handle, rc, err := s.openRun(id, false)
	if err != nil {
		return RunSnapshot{}, rc, err
	}
	defer handle.close()
	run, _, rc, err := handle.readCurrent(id)
	return run, rc, err
}

// ApplyRunResult сверяет точную identity, право и канонический вердикт.
// Публикуется один terminal; повтор может только достроить его вторичную проекцию.
func (s Store) ApplyRunResult(id RunIdentity, token, result, comment, verdict string) (int, error) {
	if !validRunResult(result) || len(comment) > 20000 || strings.ContainsRune(comment, 0) {
		return 2, fmt.Errorf("неверный результат или комментарий")
	}
	draft, err := ParseRunVerdict(result, verdict)
	if err != nil {
		return 2, err
	}
	handle, rc, err := s.openRun(id, true)
	if err != nil {
		return rc, err
	}
	defer handle.close()
	run, hash, rc, err := handle.authorize(id, token)
	if err != nil {
		return rc, err
	}
	if draft["stage"] != nil && run.Identity.LoopRole != "lead" {
		return 2, fmt.Errorf("stage-result: граница доступна только ведущему узлу цикла")
	}
	if run.State == "committed" {
		if err := handle.project.write(resultProjection(run)); err != nil {
			return 78, err
		}
		return 75, fmt.Errorf("терминальный результат запуска уже принят")
	}
	run.State, run.Result, run.Verdict = "committed", result, verdict
	run.Comment = strings.ReplaceAll(comment, "\n", " ")
	if err := handle.writeRecord(run, hash); err != nil {
		return 78, err
	}
	if err := handle.project.write(resultProjection(run)); err != nil {
		return 78, err
	}
	return 0, nil
}

func resultProjection(run RunSnapshot) []ProjectionField {
	stage := run.Identity.Stage
	return []ProjectionField{
		{stage, run.Result}, {stage + "_COMMENT", run.Comment}, {"ACTIVE_RUN_" + stage, ""},
	}
}

// authorize возвращает право лишь при полном совпадении identity и capability.
// Хэш токена никогда не попадает в диагностический ответ.
func (h *runHandle) authorize(id RunIdentity, token string) (RunSnapshot, string, int, error) {
	run, hash, rc, err := h.readCurrent(id)
	if err != nil {
		return RunSnapshot{}, "", rc, err
	}
	if token == "" || subtle.ConstantTimeCompare([]byte(digestOf([]byte(token))), []byte(hash)) != 1 {
		return RunSnapshot{}, "", 74, fmt.Errorf("право запуска не подтверждено")
	}
	if run.State == "active" && run.Identity.Node != "" {
		settings, err := h.task.readStageRunnerSettings(run.Identity.stageRunnerIdentity())
		if err != nil {
			return RunSnapshot{}, "", 78, err
		}
		if settings.restartBlocksRun(run.Identity) {
			return RunSnapshot{}, "", 73, fmt.Errorf("исходная эпоха перезапуска закрыта для статуса")
		}
	}
	return run, hash, 0, nil
}

func (h *runHandle) readRecord() (map[string]string, error) {
	raw, err := readTrusted(h.root, h.name, runRecordLimit, ownerMode)
	if err != nil {
		return nil, err
	}
	return parseRunFields(raw)
}

// readCurrent проверяет сохранённую запись до возврата принятого результата.
// Формат с ATTEMPT_ID создаёт только Go, старый writer остаётся у своего поколения.
func (h *runHandle) readCurrent(id RunIdentity) (RunSnapshot, string, int, error) {
	fields, err := h.readRecord()
	if errors.Is(err, os.ErrNotExist) {
		return RunSnapshot{}, "", 73, fmt.Errorf("запуск отсутствует")
	}
	if err != nil {
		return RunSnapshot{}, "", 78, err
	}
	if fields["RUN_ID"] != id.ID || fields["EPOCH"] != strconv.FormatUint(id.Epoch, 10) ||
		fields["ATTEMPT_ID"] != id.Attempt {
		return RunSnapshot{}, "", 73, fmt.Errorf("запуск или его эпоха сменилась")
	}
	state, result, hash := fields["STATE"], fields["RESULT"], fields["TOKEN_HASH"]
	if fields["SCHEMA"] != "1" || !digestPattern.MatchString(hash) ||
		(state != "active" && state != "committed") || (state == "active" && result != "") ||
		(state == "committed" && !validRunResult(result)) {
		return RunSnapshot{}, "", 78, fmt.Errorf("сохранённая запись запуска повреждена")
	}
	verdict := fields["VERDICT_B64"]
	if _, err := ParseRunVerdict(result, verdict); err != nil {
		return RunSnapshot{}, "", 78, err
	}
	id.Node, id.Profile = fields["NODE"], fields["PROFILE"]
	if id.Node != "" && !id.stageRunnerIdentity().valid() {
		return RunSnapshot{}, "", 78, fmt.Errorf("неверный узел в сохранённой записи запуска")
	}
	id.LoopRole = fields["LOOP_ROLE"]
	return RunSnapshot{id, state, result, fields["COMMENT"], verdict}, hash, 0, nil
}

// writeRecord сохраняет совместимые имена полей Bash плюс точную identity попытки.
// Комментарий предварительно сворачивается до одной строки.
func (h *runHandle) writeRecord(run RunSnapshot, hash string) error {
	var data strings.Builder
	fmt.Fprintf(&data, "SCHEMA=1\nRUN_ID=%s\nEPOCH=%d\nTOKEN_HASH=%s\nSTATE=%s\nATTEMPT_ID=%s\n",
		run.Identity.ID, run.Identity.Epoch, hash, run.State, run.Identity.Attempt)
	if run.Identity.Node != "" {
		fmt.Fprintf(&data, "NODE=%s\nPROFILE=%s\n", run.Identity.Node, run.Identity.Profile)
	}
	if run.Identity.LoopRole != "" {
		fmt.Fprintf(&data, "LOOP_ROLE=%s\n", run.Identity.LoopRole)
	}
	if run.Result != "" {
		fmt.Fprintf(&data, "RESULT=%s\n", run.Result)
	}
	if run.Comment != "" {
		fmt.Fprintf(&data, "COMMENT=%s\n", run.Comment)
	}
	if run.Verdict != "" {
		fmt.Fprintf(&data, "VERDICT_B64=%s\n", run.Verdict)
	}
	return publishFile(h.root, h.name, []byte(data.String()), ownerMode, true)
}

// parseRunFields читает точные построчные поля без повторов.
// Значение может содержать знак равенства, в том числе в base64.
func parseRunFields(raw []byte) (map[string]string, error) {
	text, ok := strings.CutSuffix(string(raw), "\n")
	if !ok || strings.ContainsRune(text, 0) {
		return nil, fmt.Errorf("неверная статусная запись")
	}
	fields := make(map[string]string)
	for _, line := range strings.Split(text, "\n") {
		key, value, present := strings.Cut(line, "=")
		if _, repeated := fields[key]; repeated || !present || !registryFieldPattern.MatchString(key) {
			return nil, fmt.Errorf("неверное поле статусной записи")
		}
		fields[key] = value
	}
	return fields, nil
}

func validRunResult(result string) bool {
	return result == "done" || result == "skipped" || result == "failed"
}
