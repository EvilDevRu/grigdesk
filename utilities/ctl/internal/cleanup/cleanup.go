package cleanup

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"grigdesk.local/tools/shared/i18n"
	"grigdesk.local/tools/utilities/ctl/internal/service"
	ctlterm "grigdesk.local/tools/utilities/ctl/internal/terminal"
)

type options struct {
	dry       bool
	json      bool
	inventory bool
	topic     string
	age       int64
	keep      int
	approved  map[string]bool
}

type entry struct {
	Path   string  `json:"path"`
	Bytes  *int64  `json:"bytes"`
	Status string  `json:"status"`
	Reason *string `json:"reason"`
}

type Report struct {
	Format           int     `json:"format"`
	Root             string  `json:"root"`
	DryRun           bool    `json:"dryRun"`
	OlderThanMS      int64   `json:"olderThanMs"`
	KeepGenerations  int     `json:"keepGenerations"`
	Entries          []entry `json:"entries"`
	WouldDeleteBytes int64   `json:"wouldDeleteBytes"`
	FreedBytes       int64   `json:"freedBytes"`
	ErrorCount       int     `json:"errorCount"`
	Interrupted      bool    `json:"interrupted"`
}

var duration = regexp.MustCompile(`^([1-9][0-9]*)([mhd])$`)

func parse(argv []string) (options, error) {
	result := options{age: 7 * 24 * 60 * 60 * 1000, keep: 3}
	seen := make(map[string]bool)
	for index := 0; index < len(argv); index++ {
		flag := argv[index]
		switch flag {
		case "--json":
			result.json = true
		case "--dry-run":
			result.dry = true
		case "--inventory":
			result.inventory = true
		case "--topic":
			if result.topic != "" || index+1 >= len(argv) || !validInventoryTopic(argv[index+1]) {
				return result, errInventoryTopic
			}
			index++
			result.topic = argv[index]
		case "--older-than", "--keep-generations":
			if seen[flag] || index+1 >= len(argv) {
				return result, fmt.Errorf("Неизвестный или повторный аргумент уборки: %s", flag)
			}
			seen[flag] = true
			index++
			if flag == "--older-than" {
				parsed := duration.FindStringSubmatch(argv[index])
				if len(parsed) == 0 {
					return result, errors.New("Срок: положительное целое с m, h или d (например 7d)")
				}
				unit := map[string]int64{"m": 60_000, "h": 3_600_000, "d": 86_400_000}[parsed[2]]
				number, err := strconv.ParseInt(parsed[1], 10, 64)
				if err != nil || number > (1<<53-1)/unit {
					return result, errors.New("Срок: положительное целое с m, h или d (например 7d)")
				}
				result.age = number * unit
			} else {
				number, err := strconv.ParseUint(argv[index], 10, 53)
				if err != nil || number == 0 || number > uint64(^uint(0)>>1) {
					return result, errors.New("Число поколений: положительное безопасное целое")
				}
				result.keep = int(number)
			}
		default:
			return result, fmt.Errorf("Неизвестный или повторный аргумент уборки: %s", flag)
		}
	}
	if result.topic != "" && !result.inventory {
		return result, errInventoryTopic
	}
	if result.inventory && (seen["--older-than"] || seen["--keep-generations"]) {
		return result, errInventoryFilters
	}
	return result, nil
}

func artifactRoot(env map[string]string) (string, error) {
	name := env["GRIGDESK_ARTIFACTS_DIR"]
	if name == "" {
		data, err := service.DataDirectory(env)
		if err != nil {
			return "", err
		}
		name = filepath.Join(data, "artifacts")
	}
	if !filepath.IsAbs(name) || filepath.Clean(name) == "/" {
		return "", errors.New("Уборка требует абсолютный корень артефактов.")
	}
	physical, err := filepath.EvalSymlinks(name)
	if errors.Is(err, os.ErrNotExist) {
		return filepath.Clean(name), nil
	}
	if err != nil {
		return "", err
	}
	if physical == "/" {
		return "", errors.New("Корень файловой системы нельзя убирать.")
	}
	return physical, nil
}

// Run запускает инвентаризацию без изменений либо существующую локальную уборку.
// При подтверждении в меню удаление ограничено путями из показанного отчёта.
func Run(ctx context.Context, env map[string]string, argv []string, terminal service.Terminal,
	confirm func(Report) (bool, error)) int {
	lang := i18n.CLIForEnvironment(env)
	rules, invalid := parse(argv)
	if invalid != nil {
		if invalid == errInventoryTopic || invalid == errInventoryFilters {
			return terminal.Fail(lang.Text(invalid.Error()), 2)
		}
		return terminal.Fail(invalid.Error(), 2)
	}
	root, err := artifactRoot(env)
	if err != nil {
		return terminal.Fail(err.Error(), 1)
	}
	if rules.inventory {
		return runInventory(ctx, root, rules, env, lang, terminal)
	}

	progress := ctlterm.NewProgress(terminal.Stderr, env, !rules.json)
	defer progress.Close()
	if confirm != nil && !rules.dry {
		preview := rules
		preview.dry = true
		found := scan(ctx, root, preview, progress, lang)
		progress.Line()
		if found.Interrupted {
			return 130
		}
		if found.WouldDeleteBytes == 0 {
			ShowReport(found, terminal)
			return 0
		}
		approved, err := confirm(found)
		if err == ctlterm.Exit(130) {
			return 130
		}
		if !approved || err != nil {
			return 0
		}
		// Источник списка путей после подтверждения остаётся той же физической папкой.
		current, err := artifactRoot(env)
		if err != nil || current != root {
			return terminal.Fail("Корень артефактов изменился.", 1)
		}
		rules.approved = make(map[string]bool)
		for _, item := range found.Entries {
			if item.Status == "would-delete" {
				rules.approved[item.Path] = true
			}
		}
	}
	report := scan(ctx, root, rules, progress, lang)
	progress.Close()
	if rules.json {
		encoder := json.NewEncoder(terminal.Stdout)
		encoder.SetEscapeHTML(false)
		if err := encoder.Encode(report); err != nil {
			return terminal.Fail(err.Error(), 1)
		}
	} else {
		ShowReport(report, terminal)
	}
	if report.Interrupted {
		return 130
	}
	if report.ErrorCount != 0 {
		return 1
	}
	return 0
}

// ShowReport печатает причины пропуска и байты без вывода данных файлов.
// Список строк общий с предварительным просмотром перед подтверждением.
func ShowReport(report Report, terminal service.Terminal) {
	for _, line := range ReportLines(report, false) {
		terminal.Say(line)
	}
}

// ReportLines собирает плоский отчёт для потока и интерактивного просмотра.
// Корень, итог и порог расположены перед списком для первого экрана просмотра.
func ReportLines(report Report, preview bool) []string {
	lines := []string{
		"Папка: " + service.Printable(report.Root),
		fmt.Sprintf("Порог: %g сут.; хранить поколений: %d", float64(report.OlderThanMS)/86_400_000,
			report.KeepGenerations),
	}
	total := fmt.Sprintf("Удалено, освобождено: %d байт", report.FreedBytes)
	if report.DryRun {
		total = fmt.Sprintf("К удалению: %d байт", report.WouldDeleteBytes)
	}
	if preview {
		lines = append(lines, total)
	}
	labels := map[string]string{
		"would-delete": "будет удалено", "deleted": "удалено", "skipped": "пропущено", "error": "ошибка",
	}
	reasons := map[string]string{
		"young": "моложе порога", "locked": "занят: блокировка", "lock-unknown": "неизвестный владелец блокировки",
		"protected-cache": "защищённый кэш", "keep-latest": "последние поколения", "current": "текущий каталог",
		"symlink": "символическая ссылка", "not-directory": "не каталог", "disappeared": "каталог исчез или заменён",
		"io-error": "ошибка доступа или ввода-вывода",
	}
	for _, item := range report.Entries {
		count := "—"
		if item.Bytes != nil {
			count = strconv.FormatInt(*item.Bytes, 10)
		}
		text := labels[item.Status]
		if item.Reason != nil {
			text += " (" + reasons[*item.Reason] + ")"
		}
		lines = append(lines, fmt.Sprintf("%s: %s байт — %s", service.Printable(item.Path), count, text))
	}
	if !preview {
		lines = append(lines, total)
	}
	if report.ErrorCount > 0 {
		lines = append(lines, fmt.Sprintf("Ошибок: %d", report.ErrorCount))
	}
	if report.Interrupted {
		lines = append(lines, "Уборка прервана; оставшиеся каталоги не удалены.")
	}
	return lines
}

func reasonText(reason string) *string {
	if reason == "" {
		return nil
	}
	return &reason
}

func skipped(path string, size *int64, reason string) entry {
	status := "skipped"
	if reason == "io-error" {
		status = "error"
	}
	return entry{Path: path, Bytes: size, Status: status, Reason: reasonText(reason)}
}

func nonce() string {
	var random [16]byte
	_, _ = rand.Read(random[:])
	return hex.EncodeToString(random[:])
}

func (report *Report) add(value entry) {
	report.Entries = append(report.Entries, value)
	switch value.Status {
	case "would-delete":
		report.WouldDeleteBytes += *value.Bytes
	case "deleted":
		report.FreedBytes += *value.Bytes
	case "error":
		report.ErrorCount++
	}
}

// scan собирает снимок, затем проверяет каждый путь перед отчётом или удалением.
// Процент появляется после подсчёта кандидатов и измеряет обработанные позиции.
func scan(ctx context.Context, path string, options options, progress *ctlterm.Progress, lang i18n.CLI) Report {
	report := Report{Format: 1, Root: path, DryRun: options.dry, OlderThanMS: options.age,
		KeepGenerations: options.keep, Entries: []entry{}}

	if ctx.Err() != nil {
		report.Interrupted = true
		return report
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return report
	}
	if err != nil || !info.IsDir() {
		report.add(skipped("", nil, "io-error"))
		return report
	}
	outer, err := os.OpenRoot(filepath.Dir(path))
	if err != nil {
		report.add(skipped("", nil, "io-error"))
		return report
	}
	defer outer.Close()
	rootName := filepath.Base(path)
	root, err := childRoot(outer, rootName, info)
	if err != nil {
		report.add(skipped("", nil, "io-error"))
		return report
	}
	defer root.Close()
	progress.Update(lang.Text("cleanup.progress.scan"), path, 0, 0)
	candidates, err := collect(ctx, root, "", "root")
	if err != nil && ctx.Err() == nil {
		report.add(skipped("", nil, "io-error"))
	}
	retained := protectedGenerations(candidates, options.keep)
	cutoff := time.Now().UnixMilli() - options.age
	var inheritedBusy *bool
	var barrier *heldLock
	var barrierIssue string
	defer func() {
		if barrier != nil {
			barrier.release()
		}
	}()
	stage := lang.Text("cleanup.progress.check")
	if !options.dry {
		stage = lang.Text("cleanup.progress.delete")
	}
	for index, candidate := range candidates {
		if ctx.Err() != nil {
			break
		}
		item := candidate.entry
		progress.Update(stage, item.Path, index, len(candidates))
		if item.Status != "" {
			report.add(item)
			continue
		}
		reason := lockAncestors(root, outer, rootName, item.Path, ownerOf(barrier))
		if reason == "" && candidate.generation {
			if inheritedBusy == nil {
				current := lockOwner{}
				if barrier != nil {
					current = barrier.owner
				}
				busy := busyGenerations(ctx, root, outer, rootName, lockOwner{}, current)
				inheritedBusy = &busy
			}
			if *inheritedBusy {
				reason = "locked"
			}
		}
		switch {
		case reason != "":
		case item.Reason != nil:
			reason = *item.Reason
		case retained[item.Path]:
			reason = "keep-latest"
		case candidate.fresh.UnixMilli() >= cutoff:
			reason = "young"
		case options.approved != nil && !options.approved[item.Path]:
			reason = "current"
		}
		if reason != "" {
			report.add(skipped(item.Path, item.Bytes, reason))
			continue
		}
		if options.dry {
			item.Status = "would-delete"
			report.add(item)
			continue
		}
		if barrier == nil && barrierIssue == "" {
			barrier, barrierIssue = acquireLock(outer, rootName+".cleanup.lock")
		}
		if barrierIssue != "" {
			report.add(skipped(item.Path, item.Bytes, barrierIssue))
			continue
		}
		report.add(removeCandidate(ctx, root, outer, rootName, candidate, options, cutoff, barrier.owner))
	}
	report.Interrupted = ctx.Err() != nil
	return report
}

func ownerOf(lock *heldLock) *lockOwner {
	if lock == nil {
		return nil
	}
	return &lock.owner
}

func openParent(root *os.Root, path string) (*os.Root, func(), error) {
	if path == "." {
		return root, func() {}, nil
	}
	parent := root
	var children []*os.Root
	close := func() {
		for index := len(children) - 1; index >= 0; index-- {
			_ = children[index].Close()
		}
	}
	for _, part := range strings.Split(path, string(filepath.Separator)) {
		next, err := childRoot(parent, part, nil)
		if err != nil {
			close()
			return nil, func() {}, err
		}
		children = append(children, next)
		parent = next
	}
	return parent, close, nil
}

func removeCandidate(ctx context.Context, root, outer *os.Root, rootName string, item candidate,
	options options, cutoff int64, barrier lockOwner) entry {
	name := filepath.Base(item.Path)
	parent, close, err := openParent(root, filepath.Dir(item.Path))
	if err != nil {
		return skipped(item.Path, item.Bytes, "disappeared")
	}
	defer close()
	info, err := parent.Lstat(name)
	if err != nil || !os.SameFile(item.inode, info) {
		return skipped(item.Path, item.Bytes, "disappeared")
	}
	lock, problem := acquireLock(parent, name+".lock")
	if problem != "" {
		return skipped(item.Path, item.Bytes, problem)
	}
	defer lock.release()
	current, err := childRoot(parent, name, item.inode)
	if err != nil {
		return skipped(item.Path, item.Bytes, "disappeared")
	}
	observation, err := measure(ctx, current, info, name)
	_ = current.Close()
	if ctx.Err() != nil {
		return skipped(item.Path, item.Bytes, "current")
	}
	if err != nil {
		return skipped(item.Path, item.Bytes, "io-error")
	}
	if observation.locked != "" {
		return skipped(item.Path, item.Bytes, observation.locked)
	}
	if busy := recheckLocks(root, outer, rootName, item.Path, barrier, lock.owner); busy != "" {
		return skipped(item.Path, item.Bytes, busy)
	}
	if observation.newest.UnixMilli() >= cutoff {
		return skipped(item.Path, &observation.bytes, "young")
	}
	if item.generation {
		siblings, err := collect(ctx, parent, filepath.Dir(item.Path), "generations")
		if err != nil || busyGenerations(ctx, root, outer, rootName, lock.owner, barrier) {
			return skipped(item.Path, &observation.bytes, "locked")
		}
		if protectedGenerations(siblings, options.keep)[item.Path] {
			return skipped(item.Path, &observation.bytes, "keep-latest")
		}
	}
	if !unchangedParents(root, outer, rootName, parent, filepath.Dir(item.Path)) {
		return skipped(item.Path, &observation.bytes, "disappeared")
	}
	quarantine := name + ".cleanup-" + nonce()
	if err := parent.Rename(name, quarantine); err != nil {
		return skipped(item.Path, item.Bytes, "io-error")
	}
	moved, err := parent.Lstat(quarantine)
	if err != nil || !os.SameFile(info, moved) {
		restore(parent, quarantine, name)
		return skipped(item.Path, item.Bytes, "disappeared")
	}
	if err := parent.RemoveAll(quarantine); err != nil {
		restore(parent, quarantine, name)
		return skipped(item.Path, &observation.bytes, "io-error")
	}
	return entry{Path: item.Path, Bytes: &observation.bytes, Status: "deleted"}
}

func unchangedParents(root, outer *os.Root, rootName string, parent *os.Root, relative string) bool {
	initial, err := root.Stat(".")
	if err != nil {
		return false
	}
	active, err := outer.Lstat(rootName)
	if err != nil || !os.SameFile(initial, active) {
		return false
	}
	checked, close, err := openParent(root, relative)
	if err != nil {
		return false
	}
	defer close()
	observed, err := checked.Stat(".")
	saved, originalErr := parent.Stat(".")
	return err == nil && originalErr == nil && os.SameFile(observed, saved)
}

func recheckLocks(root, outer *os.Root, rootName, path string, barrier, candidate lockOwner) string {
	// Собственная блокировка относится только к точному имени кандидата.
	for cursor := path; cursor != "."; cursor = filepath.Dir(cursor) {
		for _, suffix := range lockSuffixes {
			if busy := lockStatus(root, cursor+suffix, &candidate); busy != "" {
				return busy
			}
		}
	}
	for _, suffix := range lockSuffixes {
		if busy := lockStatus(outer, rootName+suffix, &barrier); busy != "" {
			return busy
		}
	}
	return ""
}

func busyGenerations(ctx context.Context, root, outer *os.Root, rootName string, lock, barrier lockOwner) bool {
	theme, close, err := openParent(root, "deepseek-binary")
	if err != nil {
		return true
	}
	defer close()
	info, err := theme.Stat(".")
	if err != nil {
		return true
	}
	names, err := directoryNames(theme)
	if err != nil {
		return true
	}
	if recheckLocks(root, outer, rootName, "deepseek-binary/node-cache/generations", barrier, lock) != "" {
		return true
	}
	for _, name := range names {
		if name == "node-cache" {
			continue
		}
		if lockName(name) && lockStatus(theme, name, nil) != "" {
			return true
		}
		child, err := childRoot(theme, name, nil)
		if err != nil {
			continue
		}
		tree, err := measure(ctx, child, info, name)
		_ = child.Close()
		if err != nil || tree.locked != "" {
			return true
		}
	}
	generations, closeGenerations, err := openParent(root, "deepseek-binary/node-cache/generations")
	if err != nil {
		return true
	}
	defer closeGenerations()
	entries, err := directoryNames(generations)
	if err != nil {
		return true
	}
	for _, name := range entries {
		if (lockName(name) || name == ".locks") && lockStatus(generations, name, &lock) != "" {
			return true
		}
	}
	return false
}
