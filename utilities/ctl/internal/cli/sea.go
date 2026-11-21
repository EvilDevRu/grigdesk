package cli

import (
	"context"
	"os/exec"
	"path/filepath"
	"time"

	"golang.org/x/sys/unix"

	"grigdesk.local/tools/utilities/ctl/internal/service"
	"grigdesk.local/tools/utilities/internal/installation"
)

// runSea проверяет локальный комплект и запускает его собственный launcher с тем же PID.
func runSea(ctx context.Context, root string, args []string, env map[string]string, terminal service.Terminal) int {
	server := filepath.Join(root, "server", "grigdesk-server")
	node := filepath.Join(root, "runtime", "node", "bin", "node")
	launcher := filepath.Join(root, "server", "runtime", "helpers", "launch-sea-server.mjs")
	for _, file := range []string{server, node, launcher} {
		if _, err := installation.ProveFile(file); err != nil {
			return terminal.Fail("Серверный комплект неполон: "+err.Error(), 1)
		}
	}
	delete(env, "NODE_OPTIONS")
	delete(env, "NODE_PATH")
	childEnv := installation.Environ(env)
	deadline, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	command := exec.CommandContext(deadline, server, "--check-startup")
	command.Env = childEnv
	command.Stderr = terminal.Stderr
	if err := command.Run(); err != nil {
		return terminal.Fail("Серверный комплект не прошёл проверку запуска: "+err.Error(), 1)
	}
	if err := unix.Exec(node, append([]string{node, launcher}, args...), childEnv); err != nil {
		return terminal.Fail(err.Error(), 1)
	}
	return 0
}
