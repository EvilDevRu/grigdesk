package main

import (
	"os"

	"grigdesk.local/tools/utilities/factory/internal/cli"
	"grigdesk.local/tools/utilities/factory/internal/host"
	"grigdesk.local/tools/utilities/factory/internal/runner"
)

func main() {
	if handled, rc := host.ProcessStartCommand(os.Args[1:], os.Stdout); handled {
		os.Exit(rc)
	}
	if handled, rc := host.TrustedReadCommand(os.Args[1:], os.Stdout); handled {
		os.Exit(rc)
	}
	if handled, rc := host.TrustedWriteCommand(os.Args[1:], os.Stdin); handled {
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
