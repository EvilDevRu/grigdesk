package cli

import (
	"os"
	"strconv"
	"strings"
	"testing"
)

// TestMain даёт тестовому ELF графовых часов приватный вход без смены часов машины.
// Production-бинарник переменную GRAPH_TEST_CLOCK_FILE не читает.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "graph-workflow" && os.Getenv("GRAPH_TEST_CLOCK_FILE") != "" {
		raw, err := os.ReadFile(os.Getenv("GRAPH_TEST_CLOCK_FILE"))
		if err != nil {
			os.Exit(78)
		}
		now, err := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
		if err != nil {
			os.Exit(78)
		}
		os.Exit(runGraphWorkflowWithClock(os.Args[2:], os.Stdin, os.Stdout, os.Stderr, now))
	}
	os.Exit(m.Run())
}