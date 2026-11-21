package main

import (
	"fmt"
	"io"
	"os"
	"runtime"
	"strconv"

	"grigdesk.local/tools/utilities/factory/internal/cli"
	"grigdesk.local/tools/utilities/factory/internal/host"
	"grigdesk.local/tools/utilities/factory/internal/runner"
	"grigdesk.local/tools/utilities/internal/processidentity"
)

func main() {
	if runtime.GOOS == "windows" && len(os.Args) > 1 && os.Args[1] == "_windows-starttime" {
		os.Exit(windowsStarttime(os.Args[2:], os.Stdout))
	}
	if handled, rc := host.TrustedReadCommand(os.Args[1:], os.Stdout); handled {
		os.Exit(rc)
	}
	if handled, rc := host.OrchestratorCommand(os.Args[1:]); handled {
		os.Exit(rc)
	}
	if handled, rc := host.PermitChild(os.Args[1:]); handled {
		os.Exit(rc)
	}
	if handled, rc := runner.CodexPolicyChild(os.Args[1:], os.Stdin, os.Stdout); handled {
		os.Exit(rc)
	}
	os.Exit(cli.Run(os.Args[1:], os.Stdout, os.Stderr))
}

// windowsStarttime возвращает время создания из открытого handle.
// Недоступный процесс отличается от доказанно завершённого.
func windowsStarttime(args []string, out io.Writer) int {
	if len(args) != 1 {
		return 2
	}
	pid, err := strconv.Atoi(args[0])
	if err != nil || pid <= 0 || uint64(pid) > 1<<32-1 {
		return 2
	}
	start, dead := processidentity.Start(pid)
	if dead {
		return 3
	}
	if start == "" {
		return 4
	}
	if _, err := fmt.Fprintln(out, start); err != nil {
		return 4
	}
	return 0
}
