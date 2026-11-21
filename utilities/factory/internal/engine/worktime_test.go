package engine_test

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"grigdesk.local/tools/utilities/factory/internal/state"
)

func TestWorkTime(t *testing.T) {
	f := newRouteFixture(t, false)
	f.expectStart(t, false)
	id := f.attempt(t)
	projection := filepath.Join(f.store.StateDir, "t"+testTask+".pipeline")
	before, err := os.ReadFile(projection)
	if err != nil {
		t.Fatal(err)
	}
	rc, out := f.run(t, "work-time", "--attempt", id)
	shape := regexp.MustCompile(`^work_time_s=[0-9]+\ngate_wait_s=0\nlast_event_at=[1-9][0-9]*\n$`)
	if rc != 0 || !shape.MatchString(out) {
		t.Fatalf("открытый журнал: rc=%d %s", rc, out)
	}
	f.readEqual(t, projection, string(before))
	if rc, out := f.run(t, "gate", "--attempt", id, "--node", "gate_accept", "--decision", "approved",
		"--commit-only"); rc != 0 {
		t.Fatalf("gate rc=%d %s", rc, out)
	}
	if rc, out := f.run(t, "resume", "--attempt", id); rc != 0 {
		t.Fatalf("resume rc=%d %s", rc, out)
	}
	fields := []state.ProjectionField{
		{Key: "WORK_TIME_S", Value: "12"}, {Key: "GATE_WAIT_S", Value: "9"},
		{Key: "WORK_TIMER_SINCE", Value: "123"},
	}
	if err := f.store.UpdateProjection(testTask, id, fields); err != nil {
		t.Fatal(err)
	}
	const expected = "work_time_s=12\ngate_wait_s=9\nlast_event_at=123\n"
	if rc, out := f.run(t, "work-time", "--attempt", id); rc != 0 || out != expected {
		t.Fatalf("закрытая попытка: rc=%d %s", rc, out)
	}
	if err := f.store.UpdateProjection(testTask, id, []state.ProjectionField{
		{Key: "WORK_TIME_S", Value: "broken"},
	}); err != nil {
		t.Fatal(err)
	}
	if rc, out := f.run(t, "work-time", "--attempt", id); rc != 78 {
		t.Fatalf("нет проекции закрытой попытки: rc=%d %s", rc, out)
	}

	f.expectStart(t, true)
	if f.attempt(t) == id || f.projection(t)["RESULT"] != "" {
		t.Fatalf("новая попытка унаследовала терминальную проекцию: %v", f.projection(t))
	}
	f.expectCount(t, "command", "1\n")
}

func TestFindingsExport(t *testing.T) {
	f := newRouteFixture(t, false)
	f.expectStart(t, false)
	id := f.attempt(t)
	cursor, err := f.store.ReadStage(testTask, id)
	if err != nil {
		t.Fatal(err)
	}
	const report = "# Отложенные находки задачи 7101\n"
	for _, format := range []string{"json", "markdown"} {
		rc, output := f.run(t, "findings-export", "--attempt", id, "--format", format)
		if rc != 0 {
			t.Fatalf("%s rc=%d %s", format, rc, output)
		}
		switch format {
		case "json":
			if !strings.Contains(output, `"stageLedgerHash": "`+cursor.HeadEventHash+`"`) ||
				!strings.Contains(output, `"deferred": []`) {
				t.Fatalf("неверный JSON: %s", output)
			}
		case "markdown":
			if !strings.HasPrefix(output, report) || !strings.HasSuffix(output, "Отложенных находок нет.\n") {
				t.Fatalf("неверный Markdown: %s", output)
			}
		}
	}
	after, err := f.store.ReadStage(testTask, id)
	if err != nil || after != cursor {
		t.Fatalf("экспорт изменил курсор: %+v %v", after, err)
	}
}
