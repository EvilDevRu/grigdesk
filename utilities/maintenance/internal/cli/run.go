package cli

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"slices"

	"grigdesk.local/tools/utilities/internal/buildinfo"
	"grigdesk.local/tools/utilities/internal/installation"
	"grigdesk.local/tools/utilities/maintenance/internal/install"
	"grigdesk.local/tools/utilities/maintenance/internal/update"
)

//go:embed help.txt
var help string

const kind = "grigdesk-maintenance"

type Command struct {
	Version string
}

// Run разбирает публичные параметры до действий над регистрацией установки.
func (command Command) Run(
	ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer,
) int {
	if code, handled := nativeCommand(ctx, args, stdout); handled {
		return code
	}
	if code, handled := buildinfo.Local(stdout, args, kind, command.Version, false); handled {
		return code
	}

	if slices.Equal(args, []string{"--help"}) || slices.Equal(args, []string{"-h"}) {
		_, _ = io.WriteString(stdout, help)
		return 0
	}
	if len(args) > 0 && args[0] == "control" {
		return control(ctx, args, stdin, stdout, stderr)
	}
	if len(args) > 0 && args[0] == "install-online" {
		options, err := install.ParseOptions(args[1:])
		if err == nil {
			err = install.Run(ctx, options)
		}
		if errors.Is(err, install.ErrUpdateRequiresCurrent) {
			err = prepareUpdate(ctx, options)
			if err == nil {
				return 10
			}
		}
		if err != nil {
			_, _ = fmt.Fprintln(stderr, err.Error())
			return 1
		}
		return 0
	}

	if len(args) > 0 && slices.Contains([]string{"launch", "ctl", "ctl-runtime"}, args[0]) {
		if err := installed(ctx, args, stdout); err != nil {
			_, _ = fmt.Fprintln(stderr, err.Error())
			return 1
		}
		return 0
	}

	if len(args) == 2 && slices.Contains([]string{"prepare", "apply", "recover"}, args[0]) {
		if args[0] != "prepare" {
			if err := releaseInheritedWorkerDescriptors(); err != nil {
				_, _ = fmt.Fprintln(stderr, "release_worker_descriptors_invalid")
				return 1
			}
		}
		layout, err := openInstalled()
		if err == nil {
			defer layout.Close()
			err = (update.Service{Layout: layout}).Worker(ctx, args[0], args[1])
		}
		if err != nil {
			_, _ = fmt.Fprintln(stderr, err.Error())
			return 1
		}
		return 0
	}

	if len(args) > 0 && slices.Contains([]string{
		"--verify", "install",
		"launch-update-desktop", "verify-stop-server", "install-lock-fd", "inspect-process",
	}, args[0]) {
		_, _ = fmt.Fprintln(stderr, "Команда grigdesk-maintenance ещё не перенесена на Go.")
		return 78
	}

	_, _ = fmt.Fprintln(stderr, "maintenance_action_invalid")
	return 1
}

func prepareUpdate(ctx context.Context, options install.Options) error {
	if options.Migrate {
		return install.ErrUpdateRequiresCurrent
	}
	layout, err := installation.Open(options.Root)
	if err != nil {
		return err
	}
	defer layout.Close()
	manifest, envelope, err := install.ReadRelease(options.Index)
	if err != nil {
		return err
	}
	_, err = (update.Service{Layout: layout}).PrepareOffline(ctx, options.Source, manifest, envelope)
	return err
}
