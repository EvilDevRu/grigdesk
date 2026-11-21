package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"grigdesk.local/tools/utilities/factory/internal/engine"
	"grigdesk.local/tools/utilities/factory/internal/hooks"
	"grigdesk.local/tools/utilities/factory/internal/state"
)

func launchRoute(r request, diagnostic io.Writer) int {
	input := makeLaunchRequest(r, diagnostic)
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	rc, err := engine.Launch(ctx, input)
	if err != nil {
		fmt.Fprintf(diagnostic, "factory: %s\n", err)
	}
	return rc
}

func makeLaunchRequest(r request, diagnostic io.Writer) engine.LaunchRequest {
	profile := r.value("--profile")
	file, _, _ := hooks.ProfileFiles(profile)
	control := firstNonempty(r.value("--control-dir"), os.Getenv("FACTORY_CONTROL_ROOT"))
	if control == "" {
		defaultConfig := filepath.Join(os.Getenv("HOME"), ".factory/config")
		config := firstNonempty(os.Getenv("FACTORY_CONFIG_ROOT"), defaultConfig)
		control = filepath.Join(config, "control")
	}
	return engine.LaunchRequest{
		Store: state.Store{StateDir: r.stateDir(), ControlDir: control}, Mode: r.mode, Task: r.task,
		Profile: profile, Attempt: r.value("--attempt"), Route: r.value("--route"), RoutesDir: r.routesDir(),
		ExpectedCatalog: r.value("--expected-catalog-hash"), Ticket: r.value("--ticket-json"),
		Dispatch: r.value("--queue-dispatch-id"), Runner: r.value("--runner-primary"), ProfileFile: file,
		Diagnosis: r.value("--diagnosis-kind"), Signal: r.value("--diagnosis-signal"),
		Scope: r.options["--instrumentation-file"], Targets: r.options["--delivery-target"],
		Hold: r.has("--hold-start"), TaskComment: r.has("--task-comment"), Environment: os.Environ(),
		Runtime: state.BindRuntime{
			Node:        os.Getenv("GRIGDESK_SERVER_RUNTIME_NODE"),
			Helper:      os.Getenv("GRIGDESK_SERVER_RUNTIME_PIN_HELPER"),
			Reservation: os.Getenv("GRIGDESK_SERVER_RUNTIME_RESERVATION"),
			Log:         diagnostic,
		},
		Log: diagnostic,
	}
}

func runRouteDecision(r request, out, diagnostic io.Writer) int {
	input := engine.DecisionRequest{
		LaunchRequest: makeLaunchRequest(r, diagnostic),
		Node:          r.value("--node"), Decision: r.value("--decision"),
		Comment: r.value("--comment"), Reason: r.value("--reason"), Actor: r.value("--actor"),
		ExpectedStage: r.value("--expected-stage"), CommitOnly: r.has("--commit-only"), Output: out,
		Visit: r.value("--visit"), StopHash: r.value("--stop-hash"), AnswerFile: r.value("--answer-file"),
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	rc, err := engine.Decide(ctx, input)
	if err != nil {
		fmt.Fprintf(diagnostic, "factory: %s\n", err)
	}
	return rc
}
