package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"

	"grigdesk.local/tools/utilities/internal/buildinfo"
	"grigdesk.local/tools/utilities/maintenance/internal/windowsinstall"
)

var version = "development"
var windowsReleaseKey string

func main() {
	args := os.Args[1:]
	if code, handled := buildinfo.Local(os.Stdout, args, "grigdesk-maintenance", version, false); handled {
		os.Exit(code)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	err := windowsinstall.Run(ctx, args, windowsReleaseKey)
	stop()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
