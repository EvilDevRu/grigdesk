package main

import (
	"context"
	"errors"
	"os"
	"os/signal"
	"syscall"

	"grigdesk.local/tools/utilities/ctl/internal/cli"
)

var version = "development"

var ended = errors.New("SIGTERM")

func main() {
	ctx, stop := context.WithCancelCause(context.Background())
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	go func() {
		select {
		case received := <-signals:
			if received == syscall.SIGTERM {
				stop(ended)
			} else {
				stop(context.Canceled)
			}
		case <-ctx.Done():
		}
	}()
	command := cli.Command{Version: version}
	code := command.Run(ctx, os.Args[1:], os.Stdin, os.Stdout, os.Stderr)
	if code == 130 && errors.Is(context.Cause(ctx), ended) {
		code = 143
	}
	signal.Stop(signals)
	stop(context.Canceled)
	os.Exit(code)
}
