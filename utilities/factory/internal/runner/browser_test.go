package runner

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestBrowserAdapterHost(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("брокер использует Linux identity")
	}
	run := adapterFixture(t)
	helper := filepath.Join(run.Worktree, "helper.mjs")
	if err := os.WriteFile(helper, nil, 0600); err != nil {
		t.Fatal(err)
	}
	broker := filepath.Join(run.Worktree, "broker")
	const script = `#!/bin/bash
set -eu
case "$2" in
  publish-binding)
    test -s /proc/self/fd/9
    grep -q '^STATE=active$' "$4/runner-processes/t8101.active"
    cat "$4/runner-processes/t8101.active" > broker-record
    touch broker-published
    ;;
  relay)
    touch "$FACTORY_STATUS_REQUEST_DIR/browser/host.ready"
    while :; do sleep .05; done
    ;;
  mode) printf 'grigdesk\n' ;;
  cleanup) test -s /proc/self/fd/9; touch broker-cleaned ;;
  *) exit 77 ;;
esac
`
	if err := os.WriteFile(broker, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	run.Environment = append(run.Environment,
		"FACTORY_ROUTE_BROWSER_POLICY=allow", "FACTORY_ROUTE_BROWSER_ROUTES_DIR="+run.Worktree,
		"FACTORY_PROFILES_DIR="+run.Worktree, "GRIGDESK_BROWSER_HELPER="+helper,
		"GRIGDESK_BROWSER_NODE="+broker, "GRIGDESK_BROWSER_RELAY_SOCKET="+filepath.Join(run.Worktree, "relay.sock"),
	)
	provider := fakeRunnerCLI(t, run.Worktree, "provider", `
test "$FACTORY_BROWSER_ENABLED" = 1 && test -f "$FACTORY_STATUS_REQUEST_DIR/../broker-published" || exit 91
test -n "$FACTORY_BROWSER_NONCE" && test ! -e /proc/self/fd/9 || exit 92
`+submitFixtureResult)
	result, refusal := run.invoke("deepseek", invocation{path: provider, cwd: run.Worktree, deferred: true})
	if refusal != nil || result.RC != 0 {
		t.Fatalf("брокер не разрешил запуск: rc=%d %v", result.RC, refusal)
	}
	checkFixtureFile(t, filepath.Join(run.Dir, "broker-record"), "RUN_ID=rfixture", "STATE=active")
	checkFixtureFile(t, filepath.Join(run.Dir, "broker-cleaned"))
	process := filepath.Join(run.Store.ControlDir, "runner-processes", "t8101.active")
	if _, err := os.Stat(process); !os.IsNotExist(err) {
		t.Fatalf("право на завершившийся запуск осталось: %v", err)
	}
}
