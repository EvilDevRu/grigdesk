package cli

import (
	"context"
	"encoding/json"
	"io"
	"strconv"

	"grigdesk.local/tools/utilities/internal/processidentity"
)

func releaseInheritedWorkerDescriptors() error {
	return nil
}

func nativeCommand(ctx context.Context, args []string, stdout io.Writer) (int, bool) {
	if len(args) == 1 && args[0] == "install-lock-fd" {
		return processidentity.DarwinLease(3), true
	}
	if len(args) == 2 && args[0] == "inspect-process" {
		pid, err := strconv.Atoi(args[1])
		if err != nil || pid <= 0 {
			return 74, true
		}
		identity, code := processidentity.InspectDarwin(ctx, pid)
		if code == 0 && json.NewEncoder(stdout).Encode(identity) != nil {
			return 74, true
		}
		return code, true
	}
	return 0, false
}
