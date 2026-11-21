package cli

import (
	"bytes"
	"runtime"
	"testing"
)

func TestCapabilities(t *testing.T) {
	var out, diagnostic bytes.Buffer

	rc := Run([]string{"capabilities", "--format", "json"}, &out, &diagnostic)
	expected := `{"schema":1,"features":["goto-expected-stage-v1","native-subcommands"`
	if runtime.GOOS == "linux" {
		expected += `,"stage-runner-settings-v1"`
	}
	expected += `]}` + "\n"
	if rc != 0 || out.String() != expected || diagnostic.Len() != 0 {
		t.Fatalf("rc=%d stdout=%q stderr=%q", rc, out.String(), diagnostic.String())
	}

	out.Reset()
	rc = Run([]string{"capabilities", "--format", "xml"}, &out, &diagnostic)
	if rc != 78 || out.Len() != 0 || diagnostic.Len() == 0 {
		t.Fatalf("неверный формат: rc=%d stdout=%q stderr=%q", rc, out.String(), diagnostic.String())
	}
}
