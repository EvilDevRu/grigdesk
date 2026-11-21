package update

import (
	"context"
	"errors"
	"os/exec"

	"grigdesk.local/tools/utilities/internal/installation"
)

func startPlatformService(context.Context, *installation.Layout) (bool, error) {
	return false, nil
}

func stopPlatformService(context.Context, *installation.Layout) error {
	return errors.New("release_service_unavailable")
}

func serverJournal(context.Context, *installation.Layout, string, bool) (*exec.Cmd, error) {
	return nil, nil
}
