package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"grigdesk.local/tools/utilities/maintenance/internal/cli"
)

var version = "development"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	command := cli.Command{Version: version}
	code := command.Run(ctx, os.Args[1:], os.Stdin, os.Stdout, os.Stderr)
	stop()
	os.Exit(code)
}
