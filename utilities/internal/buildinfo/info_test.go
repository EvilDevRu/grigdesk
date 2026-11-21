package buildinfo

import (
	"bytes"
	"encoding/json"
	"runtime"
	"testing"
)

// TestWrite проверяет, что вывод можно прочитать как отдельный JSON-ответ.
// Поля идентифицируют конкретную команду и среду, в которой она собрана.
func TestWrite(t *testing.T) {
	var out bytes.Buffer
	if err := Write(&out, "tracker", "0.2.0"); err != nil {
		t.Fatal(err)
	}

	var info Info
	if err := json.Unmarshal(out.Bytes(), &info); err != nil {
		t.Fatal(err)
	}

	if info.Schema != 1 || info.Kind != "tracker" || info.Version != "0.2.0" ||
		info.Runtime != "go" || info.Go != runtime.Version() ||
		info.OS != runtime.GOOS || info.Arch != runtime.GOARCH {
		t.Fatalf("неверная идентичность: %+v", info)
	}
}
