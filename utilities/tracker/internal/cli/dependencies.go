package cli

import (
	"context"

	"grigdesk.local/tools/utilities/tracker/internal/task"
)

type Dependencies struct {
	Env     map[string]string
	Config  task.ConfigIO
	Request func(context.Context, task.Connection, task.RequestSpec) ([]byte, error)
}
