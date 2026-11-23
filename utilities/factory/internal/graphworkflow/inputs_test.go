package graphworkflow

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestNormalizeInputsKeepsSameNamesDistinct(t *testing.T) {
	snapshot, err := NormalizeInputs("documents", []InputFile{
		{Name: "plan.md", Text: "первый"},
		{Name: "plan.md", Text: "второй"},
	})
	if err != nil || len(snapshot.Rows) != 2 {
		t.Fatalf("одноимённые файлы дают разные записи: %+v %v", snapshot, err)
	}
	if snapshot.Rows[0].Key != "file-1" || snapshot.Rows[1].Key != "file-2" {
		t.Fatalf("ключи входов назначает движок: %+v", snapshot.Rows)
	}
	if snapshot.Rows[0].Sources[0].InputKey != "file-1" || snapshot.Rows[1].Sources[0].InputKey != "file-2" {
		t.Fatalf("источники независимы: %+v", snapshot.Rows)
	}
	if len(snapshot.Manifest) != 2 || snapshot.Manifest[0].Text != "первый" {
		t.Fatalf("манифест сохраняет оба входа: %+v", snapshot.Manifest)
	}
	for _, bad := range []InputFile{
		{Name: "../other.txt", Text: "x"},
		{Name: "a/b.txt", Text: "x"},
		{Name: "..", Text: "x"},
		{Name: "file.exe", Text: "x"},
		{Name: "bad.txt", Text: "\xff\xfe"},
		{Name: "nul.txt", Text: "a\x00b"},
		{Name: "big.txt", Text: strings.Repeat("a", 64*1024+1)},
	} {
		if _, err := NormalizeInputs("documents", []InputFile{bad}); err == nil {
			t.Fatalf("вход %+v должен отвергаться", bad)
		}
	}
	total := make([]InputFile, 0, 5)
	for index := 0; index < 5; index++ {
		total = append(total, InputFile{Name: fmt.Sprintf("f%d.txt", index), Text: strings.Repeat("a", 60*1024)})
	}
	if _, err := NormalizeInputs("documents", total); err == nil {
		t.Fatalf("суммарный объём входов ограничен")
	}
	if _, err := NormalizeInputs("transcript", []InputFile{
		{Name: "a.txt", Text: "x"}, {Name: "b.txt", Text: "y"},
	}); err == nil {
		t.Fatalf("расшифровка принимает один файл")
	}
}

func TestDocumentTemplateStartsTwoNestedJobs(t *testing.T) {
	var def Definition
	if err := json.Unmarshal([]byte(documentsTemplate), &def); err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeDefinition([]byte(documentsTemplate)); err != nil {
		t.Fatalf("канонический шаблон документов валиден: %v", err)
	}
	snapshot, err := NormalizeInputs("documents", []InputFile{
		{Name: "notes.md", Text: "# A\nпервый\n# B\nвторой"},
	})
	if err != nil {
		t.Fatal(err)
	}
	run := NewRun(def, snapshot.Rows)
	run.Manifest = snapshot.Manifest
	if err := run.Advance(); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"files.1.parts.1.summary", "files.1.parts.2.summary"} {
		assertStatus(t, run, id, "ready")
	}
	first, err := run.RowsFor(ResultRef{ID: "files.1.parts.1.summary", Generation: 1}, claimRowsLimit)
	if err != nil || len(first) != 1 || first[0].Sources[0].Line != 1 {
		t.Fatalf("первый лист читает раздел со строки 1: %+v %v", first, err)
	}
	second, err := run.RowsFor(ResultRef{ID: "files.1.parts.2.summary", Generation: 1}, claimRowsLimit)
	if err != nil || len(second) != 1 || second[0].Sources[0].Line != 3 {
		t.Fatalf("второй лист читает раздел со строки 3: %+v %v", second, err)
	}
}

func TestTranscriptKeepsOriginalLineAfterBlankSegment(t *testing.T) {
	raw := `[{"start":12,"end":12,"text":" "},{"start":12,"end":16,"text":"Решили проверить отчёт"}]`
	snapshot, err := NormalizeInputs("transcript", []InputFile{{Name: "meeting.json", Text: raw}})
	if err != nil || len(snapshot.Rows) != 1 {
		t.Fatalf("пустая реплика пропускается, остаётся одна запись: %+v %v", snapshot, err)
	}
	row := snapshot.Rows[0]
	if row.Key != "row-2" || len(row.Sources) != 1 {
		t.Fatalf("ключ хранит исходный номер элемента: %+v", row)
	}
	source := row.Sources[0]
	if source.InputKey != "file-1" || source.Line != 2 || source.TimeMs == nil || *source.TimeMs != 12000 {
		t.Fatalf("адрес ссылается на исходный элемент 2 с timeMs 12000: %+v", source)
	}
	segments, err := TranscriptSegments(raw)
	if err != nil || len(segments) != 2 || segments[0].Line != 1 || segments[1].Line != 2 ||
		segments[0].TimeMs != 12000 || segments[1].TimeMs != 12000 {
		t.Fatalf("GET input восстанавливает обе исходные метки: %+v %v", segments, err)
	}
}

func TestNormalizeInputsRejectsBadTranscript(t *testing.T) {
	for _, raw := range []string{
		`[{"start":5,"end":6,"text":"a"},{"start":1,"end":2,"text":"b"}]`,
		`[{"start":5,"end":4,"text":"a"}]`,
		`[{"start":-1,"end":2,"text":"a"}]`,
		`[{"start":9007199254741,"end":9007199254742,"text":"a"}]`,
		`[{"start":1,"end":2,"text":"a","extra":1}]`,
		`{"start":1}`,
	} {
		if _, err := NormalizeInputs("transcript", []InputFile{{Name: "m.json", Text: raw}}); err == nil {
			t.Fatalf("расшифровка %s должна отвергаться", raw)
		}
	}
	snapshot, err := NormalizeInputs("transcript", []InputFile{{Name: "m.txt", Text: "первая\n\nвторая\r\n"}})
	if err != nil || len(snapshot.Rows) != 2 {
		t.Fatalf("TXT даёт непустые физические строки: %+v %v", snapshot, err)
	}
	if snapshot.Rows[0].Sources[0].Line != 1 || snapshot.Rows[1].Sources[0].Line != 3 {
		t.Fatalf("номера строк фактические: %+v", snapshot.Rows)
	}
	if snapshot.Rows[0].Sources[0].TimeMs != nil {
		t.Fatalf("TXT не несёт таймкодов")
	}
}

func TestInputBudgetsSeparateRefsFromOutput(t *testing.T) {
	files := make([]InputFile, 0, 4)
	for index := 1; index <= 4; index++ {
		files = append(files, InputFile{Name: fmt.Sprintf("f%d.txt", index), Text: strings.Repeat("<", 40*1024)})
	}
	snapshot, err := NormalizeInputs("documents", files)
	if err != nil || len(snapshot.Rows) != 4 {
		t.Fatalf("четыре файла по 40 КиБ дают четыре входа: %+v %v", snapshot, err)
	}
	var def Definition
	if err := json.Unmarshal([]byte(documentsTemplate), &def); err != nil {
		t.Fatal(err)
	}
	run := NewRun(def, snapshot.Rows)
	if err := run.Advance(); err != nil {
		t.Fatal(err)
	}
	ready := 0
	for _, id := range run.Order {
		if run.Nodes[id].Status == "ready" {
			ready++
		}
	}
	if ready != 4 {
		t.Fatalf("четыре экземпляра готовы одновременно: %d", ready)
	}
	oneLine := InputFile{Name: "line.txt", Text: strings.Repeat("a", 65536)}
	lineSnapshot, err := NormalizeInputs("documents", []InputFile{oneLine})
	if err != nil {
		t.Fatal(err)
	}
	lineRun := NewRun(def, lineSnapshot.Rows)
	if err := lineRun.Advance(); err != nil {
		t.Fatal(err)
	}
	assertStatus(t, lineRun, "files.1.parts.1.summary", "ready")
	parts, err := lineRun.RowsFor(ResultRef{ID: "files.1.sections", Generation: 1}, claimRowsLimit)
	if err != nil || len(parts) != 1 || parts[0].Sources[0].Line != 1 {
		t.Fatalf("строка ровно 65536 байт даёт одну секцию со строки 1: %+v %v", parts, err)
	}
	lines := make([]string, 0, 35)
	for index := 1; index <= 35; index++ {
		lines = append(lines, fmt.Sprintf("реплика %d", index))
	}
	transcript, err := NormalizeInputs("transcript", []InputFile{{Name: "m.txt", Text: strings.Join(lines, "\n")}})
	if err != nil || len(transcript.Rows) != 35 {
		t.Fatalf("35 реплик дают 35 входных строк, лимит 32 относится к выходу модели: %+v %v", transcript, err)
	}
}
