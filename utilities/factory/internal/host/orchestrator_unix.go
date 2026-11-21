//go:build unix

package host

import (
	"context"
	"io"
)

func OrchestratorContext(ctx context.Context, _, _ string) (context.Context, func(), error) {
	return ctx, func() {}, nil
}

func OrchestratorCommand(_ []string) (bool, int) {
	return false, 0
}

func TrustedReadCommand(_ []string, _ io.Writer) (bool, int) {
	return false, 0
}
