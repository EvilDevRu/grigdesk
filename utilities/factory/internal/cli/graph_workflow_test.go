package cli

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"grigdesk.local/tools/utilities/factory/internal/state"
)

func TestGraphWorkflowCLIKeepsLegacy(t *testing.T) {
	root := filepath.Join(t.TempDir(), "control")
	store := state.Store{ControlDir: root}
	templateID := "a2372fd2-e591-41c8-964a-64d321e3c677"
	document := []byte(`{"title":"Тест","inputKind":"documents","scope":{"returns":["source"],` +
		`"steps":[{"id":"source","title":"Источник","kind":"input"}]}}`)
	header, _, err := store.SaveGraphTemplate(templateID, nil, document)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("FACTORY_CONTROL_ROOT", root)

	var out, diagnostic bytes.Buffer
	rc := runGraphWorkflow([]string{"templates"}, strings.NewReader(`{}`), &out, &diagnostic)
	if rc != 0 {
		t.Fatalf("templates rc=%d stdout=%s stderr=%s", rc, out.String(), diagnostic.String())
	}
	var reply struct {
		OK   bool `json:"ok"`
		Data struct {
			Templates []state.GraphTemplateHeader `json:"templates"`
		} `json:"data"`
	}
	if err := json.Unmarshal(out.Bytes(), &reply); err != nil || !reply.OK {
		t.Fatalf("неверный ответ templates: %s %v", out.String(), err)
	}
	var saved *state.GraphTemplateHeader
	for index := range reply.Data.Templates {
		if reply.Data.Templates[index].ID == templateID {
			saved = &reply.Data.Templates[index]
		}
	}
	if saved == nil || saved.Revision != header.Revision || len(reply.Data.Templates) != 3 {
		t.Fatalf("каталог возвращает сохранённый документ и встроенные шаблоны: %+v", reply.Data.Templates)
	}

	out.Reset()
	rc = Run([]string{"graph-workflow", "nonexistent"}, &out, &diagnostic)
	if rc != 65 || !strings.Contains(out.String(), "command_unknown") {
		t.Fatalf("неправильная команда даёт 65: rc=%d stdout=%s", rc, out.String())
	}
	out.Reset()
	rc = Run([]string{"graph-workflow"}, &out, &diagnostic)
	if rc != 65 {
		t.Fatalf("пустая подкоманда даёт 65: rc=%d", rc)
	}
	templates, _, err := store.ListGraphTemplates("")
	if err != nil || len(templates) != 3 {
		t.Fatalf("неправильная команда не создаёт записей: %+v %v", templates, err)
	}
}

func TestGraphWorkflowCLIStartAndRead(t *testing.T) {
	root := filepath.Join(t.TempDir(), "control")
	store := state.Store{ControlDir: root}
	templateID := "a2372fd2-e591-41c8-964a-64d321e3c677"
	document := []byte(`{"title":"Старт","inputKind":"documents","scope":{"returns":["source"],` +
		`"steps":[{"id":"source","title":"Источник","kind":"input"}]}}`)
	header, _, err := store.SaveGraphTemplate(templateID, nil, document)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("FACTORY_CONTROL_ROOT", root)
	runID := "74906bac-48d5-40ce-a6a9-96cbce242146"
	body := `{"id":"` + runID + `","templateId":"` + templateID + `","expectedRevision":"` + header.Revision +
		`","files":[{"name":"a.txt","text":"вход"}],"modelRef":{"provider":"claude","model":"test"}}`

	var out, diagnostic bytes.Buffer
	rc := runGraphWorkflow([]string{"start"}, strings.NewReader(body), &out, &diagnostic)
	if rc != 0 || !strings.Contains(out.String(), `"revision":1`) {
		t.Fatalf("start rc=%d stdout=%s stderr=%s", rc, out.String(), diagnostic.String())
	}
	out.Reset()
	rc = runGraphWorkflow([]string{"start"}, strings.NewReader(body), &out, &diagnostic)
	if rc != 0 || !strings.Contains(out.String(), `"revision":1`) {
		t.Fatalf("повтор старта идемпотентен: rc=%d stdout=%s", rc, out.String())
	}
	out.Reset()
	rc = runGraphWorkflow([]string{"read"}, strings.NewReader(`{"id":"`+runID+`"}`), &out, &diagnostic)
	if rc != 0 {
		t.Fatalf("read rc=%d stdout=%s", rc, out.String())
	}
	var reply struct {
		OK   bool `json:"ok"`
		Data struct {
			ID       string `json:"id"`
			Revision uint64 `json:"revision"`
			Status   string `json:"status"`
			Nodes    []struct {
				ID string `json:"id"`
			} `json:"nodes"`
		} `json:"data"`
	}
	if err := json.Unmarshal(out.Bytes(), &reply); err != nil || !reply.OK {
		t.Fatalf("неверный ответ read: %s %v", out.String(), err)
	}
	if reply.Data.ID != runID || reply.Data.Revision != 1 || reply.Data.Status != "done" ||
		len(reply.Data.Nodes) != 1 || reply.Data.Nodes[0].ID != "source" {
		t.Fatalf("проекция read возвращает снимок: %+v", reply.Data)
	}
	out.Reset()
	rc = runGraphWorkflow([]string{"read"}, strings.NewReader(`{"id":"b1690525-b349-422c-a165-778def939e5c"}`), &out, &diagnostic)
	if rc != 44 {
		t.Fatalf("неизвестный прогон даёт 44: rc=%d", rc)
	}
	out.Reset()
	rc = runGraphWorkflow([]string{"template-save"}, strings.NewReader(
		`{"id":"builtin-documents","expectedRevision":null,"document":`+string(document)+`}`), &out, &diagnostic)
	if rc != 65 || !strings.Contains(out.String(), "builtin_readonly") {
		t.Fatalf("встроенный ID защищён от записи: rc=%d stdout=%s", rc, out.String())
	}
}
