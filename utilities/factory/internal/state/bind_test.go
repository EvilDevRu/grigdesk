package state

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestMain(m *testing.M) {
	if os.Getenv("FACTORY_TEST_GO_BEGIN") == "1" {
		os.Exit(runBindFixture())
	}
	if mode := os.Getenv("FACTORY_TEST_STAGE_CHILD"); mode != "" {
		os.Exit(runStageFixture(mode))
	}
	if os.Getenv("FACTORY_TEST_GRAPH_MODEL_RPC") == "1" {
		os.Exit(runGraphModelRPC())
	}
	if os.Getenv("FACTORY_TEST_GRAPH_MODEL_CHILD") == "1" {
		os.Exit(runGraphModelChild())
	}
	os.Exit(m.Run())
}

// runBindFixture даёт Node-тесту вход в реальную операцию begin.
// Драйвер есть только в тестовом бинарнике и не диспетчеризует провайдер.
func runBindFixture() int {
	store := Store{
		ControlDir: os.Getenv("FACTORY_CONTROL_ROOT"),
		StateDir:   os.Getenv("FACTORY_STATE"),
	}
	input := BeginInput{
		Task: "42", Profile: "demo-profile", RoutesDir: filepath.Join(os.Getenv("TEST_ROOT"), "routes"),
		Runtime: BindRuntime{
			Node:        os.Getenv("GRIGDESK_SERVER_RUNTIME_NODE"),
			Helper:      os.Getenv("GRIGDESK_SERVER_RUNTIME_PIN_HELPER"),
			Reservation: os.Getenv("GRIGDESK_SERVER_RUNTIME_RESERVATION"),
			Log:         os.Stderr,
		},
	}
	attempt, rc, err := store.BeginAttempt(input)
	if rc != 0 {
		fmt.Fprintln(os.Stderr, err)
		return rc
	}
	fmt.Println(attempt.ID)
	marker := filepath.Join(os.Getenv("TEST_ROOT"), "provider.marker")
	if err := os.WriteFile(marker, []byte("допущено\n"), 0600); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

func TestBindPublishedAttempt(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	file := filepath.Join(dir, "pin helper")
	capture := filepath.Join(dir, "argv")
	t.Setenv("PIN_TEST_CAPTURE", capture)
	source := "printf '%s\\0' \"$@\" > \"$PIN_TEST_CAPTURE\"\nexit 75\n"
	if err := os.WriteFile(file, []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	if rc := bindPublishedAttempt("", "", "", "71", "a_test", dir, io.Discard); rc != 0 {
		t.Fatalf("пустой source-контекст: %d", rc)
	}
	if rc := bindPublishedAttempt(bash, file, "", "71", "a_test", dir, io.Discard); rc != 78 {
		t.Fatalf("неполный набор переменных: %d", rc)
	}
	if _, err := os.Stat(capture); !os.IsNotExist(err) {
		t.Fatalf("helper вызывался до проверки полного контекста: %v", err)
	}
	reservation := filepath.Join(dir, "reservation $5")
	rc := bindPublishedAttempt(bash, file, reservation, "71", "a_test", dir, io.Discard)
	if rc != 75 {
		t.Fatalf("потерян код helper: %d", rc)
	}
	raw, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Split(strings.TrimSuffix(string(raw), "\x00"), "\x00")
	want := []string{"bind", "--reservation", reservation, "--task", "71",
		"--attempt", "a_test", "--attempt-dir", dir}
	if !slices.Equal(got, want) {
		t.Fatalf("аргументы bind: %q, ожидалось %q", got, want)
	}
}
