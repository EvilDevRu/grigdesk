package install

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"

	"grigdesk.local/tools/utilities/internal/installation"
)

func newPointer(receipt installation.Receipt, version string) installation.Pointer {
	generation := "generations/" + version
	pointer := installation.Pointer{Format: 2, InstallationID: receipt.InstallationID, Control: &generation, Floor: version}
	if receipt.Mode != "remote" {
		server := generation + "/server"
		pointer.Server = &server
	}
	if receipt.Mode != "server" {
		desktop := generation + "/desktop"
		pointer.Desktop = &desktop
	}
	return pointer
}

func prepare(ctx context.Context, options Options, release selectedRelease, intent string) (preparation, error) {
	stage, err := os.MkdirTemp(filepath.Dir(options.Root), stageName(options.Root))
	if err != nil {
		return preparation{}, err
	}
	retain := false
	defer func() {
		if !retain {
			_ = os.RemoveAll(stage)
		}
	}()
	receipt, err := installation.NewReceipt(installation.Receipt{
		InstallationID: installation.UUID(), UID: os.Getuid(), Root: options.Root, Mode: options.Mode,
		Channel: release.Manifest.Channel, DataHome: options.DataHome, UserData: options.UserData,
	})
	if err != nil {
		return preparation{}, err
	}
	pointer := newPointer(receipt, release.Manifest.Version)
	if err := stageFiles(ctx, stage, options.Source, release, receipt, pointer); err != nil {
		return preparation{}, err
	}
	if runtime.GOOS == "darwin" && pointer.Server != nil {
		agent := launchAgent(options, receipt)
		if err := publishJSON(filepath.Join(stage, "service.json"), macServiceReceipt(receipt, agent)); err != nil {
			return preparation{}, err
		}
		if err := installation.PublishFile(filepath.Join(stage, "update", "server.log"), nil, 0o600); err != nil {
			return preparation{}, err
		}
	}
	tree, err := verifyTree(stage, nil)
	if err != nil {
		return preparation{}, err
	}
	stageInfo, err := os.Lstat(stage)
	if err != nil {
		return preparation{}, err
	}
	parent, err := os.Lstat(filepath.Dir(stage))
	if err != nil || !parent.IsDir() {
		return preparation{}, errors.New("installation_parent_changed")
	}
	saved := preparation{
		Schema: 1, UID: os.Getuid(), Options: boundOptions(options), Receipt: receipt, Pointer: pointer,
		Digest: release.Manifest.Digest, ReleaseID: release.Manifest.ReleaseID, Stage: stage,
		StageID: installation.FileIdentity(stageInfo), ParentID: installation.FileIdentity(parent),
		Files: tree, Outputs: publications(boundOptions(options), receipt, pointer),
	}
	data, err := installation.JSONBytes(saved)
	if err != nil {
		return preparation{}, err
	}
	if err := installation.SyncDirectory(stage); err != nil {
		return preparation{}, err
	}
	if err := installation.PublishFile(intent, data, 0o600); err != nil {
		return preparation{}, err
	}
	retain = true
	return saved, nil
}

func stageFiles(ctx context.Context, stage, source string, release selectedRelease, receipt installation.Receipt,
	pointer installation.Pointer) error {
	generation := filepath.Join(stage, *pointer.Control)
	if err := os.MkdirAll(generation, 0o700); err != nil {
		return err
	}
	for _, part := range []struct {
		name string
		path *string
	}{
		{"control", pointer.Control},
		{"server", pointer.Server},
		{"desktop", pointer.Desktop},
	} {
		if part.path == nil {
			continue
		}
		target := filepath.Join(stage, *part.path)
		if err := installation.StageArtifact(ctx, source, target, part.name, release.Manifest); err != nil {
			return err
		}
		if part.name == "desktop" && runtime.GOOS == "darwin" {
			if err := MaterializeMacDesktop(ctx, target); err != nil {
				return err
			}
		}
	}
	update := filepath.Join(stage, "update")
	if err := os.Mkdir(update, 0o700); err != nil {
		return err
	}
	helper, err := copyHelper(filepath.Join(update, "maintenance"))
	if err != nil {
		return err
	}
	binding := map[string]any{
		"schema": 1, "installationId": receipt.InstallationID, "size": helper.Size, "sha256": helper.SHA256,
	}
	if err := publishJSON(filepath.Join(update, "maintenance.json"), binding); err != nil {
		return err
	}
	if err := publishJSON(filepath.Join(stage, "installation.json"), receipt); err != nil {
		return err
	}
	if err := installation.PublishFile(filepath.Join(generation, "release.json"), append(release.Envelope, '\n'),
		0o600); err != nil {
		return err
	}
	if pointer.Server != nil {
		bin := filepath.Join(stage, "bin")
		if err := os.Mkdir(bin, 0o700); err != nil {
			return err
		}
		return installation.PublishFile(filepath.Join(bin, "grigdesk-server"),
			launcher(receipt.Root, "launch server"), 0o755)
	}
	return nil
}

func publishJSON(path string, payload any) error {
	data, err := installation.JSONBytes(payload)
	if err != nil {
		return err
	}
	return installation.PublishFile(path, data, 0o600)
}

func verifyTree(root string, want map[string]installation.FileProof) (map[string]installation.FileProof, error) {
	files := make(map[string]installation.FileProof)
	err := filepath.WalkDir(root, func(file string, entry fs.DirEntry, walkError error) error {
		if walkError != nil {
			return walkError
		}
		relative, err := filepath.Rel(root, file)
		if err != nil {
			return err
		}
		if relative == "current.json" && want != nil {
			return nil
		}
		if entry.IsDir() {
			info, err := entry.Info()
			if err != nil {
				return err
			}
			stat, ok := info.Sys().(*syscall.Stat_t)
			if !ok || int(stat.Uid) != os.Getuid() || info.Mode().Perm()&0o022 != 0 {
				return errors.New("installation_staging_invalid")
			}
			proof := installation.FileProof{SHA256: "directory", Mode: uint32(info.Mode().Perm())}
			if want != nil && want[relative] != proof {
				return errors.New("installation_staging_changed")
			}
			files[relative] = proof
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 && runtime.GOOS == "darwin" && strings.Contains(relative, "/grigdesk.app/") {
			target, err := os.Readlink(file)
			if err != nil || !safeBundleLink(relative, target) {
				return errors.New("installation_staging_invalid")
			}
			proof := installation.FileProof{SHA256: installation.Hash([]byte(target)), Size: int64(len(target))}
			if want != nil && want[relative] != proof {
				return errors.New("installation_staging_changed")
			}
			files[relative] = proof
			return nil
		}
		proof, err := installation.ProveFile(file)
		if err != nil {
			return err
		}
		if want != nil && want[relative] != proof {
			return errors.New("installation_staging_changed")
		}
		files[relative] = proof
		return nil
	})
	if err != nil {
		return nil, err
	}
	if want != nil && len(files) != len(want) {
		return nil, errors.New("installation_staging_missing_file")
	}
	return files, nil
}

func publish(ctx context.Context, saved preparation, intent string) error {
	return publishAt(ctx, saved, intent, func(string) {})
}

func publishAt(ctx context.Context, saved preparation, intent string, checkpoint func(string)) error {
	root := saved.Options.Root
	parent, err := os.Lstat(filepath.Dir(root))
	if err != nil || installation.FileIdentity(parent) != saved.ParentID {
		return errors.New("installation_parent_changed")
	}
	info, err := os.Lstat(root)
	switch {
	case errors.Is(err, os.ErrNotExist):
		if err := confirmStage(saved.Stage, saved); err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := installation.MoveNoReplaceAt(saved.Stage, root, saved.ParentID); err != nil {
			return errors.New("installation_root_conflict")
		}
		checkpoint("root")
	case err != nil || !info.IsDir() || installation.FileIdentity(info) != saved.StageID:
		return errors.New("installation_root_conflict")
	default:
		if _, err := os.Lstat(saved.Stage); !errors.Is(err, os.ErrNotExist) {
			return errors.New("installation_staging_conflict")
		}
	}
	if err := confirmStage(root, saved); err != nil {
		return err
	}
	for _, folder := range []string{saved.Options.DataHome, saved.Options.UserData} {
		if err := installation.CheckParents(folder); err != nil {
			return err
		}
		if err := os.MkdirAll(folder, 0o700); err != nil {
			return err
		}
	}
	if err := checkPublications(saved.Outputs); err != nil {
		return err
	}
	if existing, err := os.Lstat(filepath.Join(root, "current.json")); err == nil {
		want, marshalError := installation.JSONBytes(saved.Pointer)
		proof, proveError := installation.ProveFile(filepath.Join(root, "current.json"))
		if marshalError != nil || proveError != nil || !existing.Mode().IsRegular() ||
			proof.Mode != 0o600 || proof.SHA256 != installation.Hash(want) {
			return errors.New("installation_current_conflict")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	for index, target := range saved.Outputs {
		checkpoint(fmt.Sprintf("before-external-%d", index))
		if err := ctx.Err(); err != nil {
			return err
		}
		parent := filepath.Dir(target.Path)
		if err := os.MkdirAll(parent, 0o700); err != nil {
			return err
		}
		if err := installation.PublishFile(target.Path, target.Bytes, os.FileMode(target.Mode)); err != nil {
			return err
		}
		checkpoint(fmt.Sprintf("after-external-%d", index))
	}
	checkpoint("before-current")
	// current появляется после всех внешних публикаций и связывает готовые компоненты.
	if err := publishJSON(filepath.Join(root, "current.json"), saved.Pointer); err != nil {
		return err
	}
	checkpoint("after-current")
	if err := os.Remove(intent); err != nil {
		return err
	}
	return installation.SyncDirectory(filepath.Dir(root))
}

func confirmStage(root string, saved preparation) error {
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || installation.FileIdentity(info) != saved.StageID {
		return errors.New("installation_staging_changed")
	}
	_, err = verifyTree(root, saved.Files)
	return err
}

func checkExternal(options Options) error {
	receipt := installation.Receipt{Root: options.Root, Mode: options.Mode, DataHome: options.DataHome}
	pointer := newPointer(receipt, "0.0.0")
	for _, target := range publications(options, receipt, pointer) {
		if _, err := os.Lstat(target.Path); !errors.Is(err, os.ErrNotExist) {
			return errors.New("installation_publish_conflict")
		}
	}
	return nil
}

func checkPublications(targets []publication) error {
	for _, target := range targets {
		if err := installation.CheckParents(filepath.Dir(target.Path)); err != nil {
			return err
		}
		proof, err := installation.ProveFile(target.Path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil || proof.Mode != target.Mode || proof.SHA256 != installation.Hash(target.Bytes) {
			return errors.New("installation_publish_conflict")
		}
	}
	return nil
}

func launcher(root, args string) []byte {
	return []byte("#!/bin/sh\nexec '" + filepath.Join(root, "update", "maintenance") + "' " + args + " \"$@\"\n")
}

func publications(options Options, receipt installation.Receipt, pointer installation.Pointer) []publication {
	result := []publication{{Path: filepath.Join(options.BinDir, "grigdesk-ctl"), Mode: 0o755,
		Bytes: launcher(options.Root, "ctl")}}
	if pointer.Desktop != nil {
		executable := filepath.Join(options.BinDir, "grigdesk")
		result = append(result, publication{Path: executable, Mode: 0o755, Bytes: launcher(options.Root, "launch desktop")})
		if runtime.GOOS == "linux" {
			text := "[Desktop Entry]\nType=Application\nName=GrigDesk\nExec=" + strconv.Quote(executable) +
				"\nTerminal=false\nCategories=Network;\n"
			result = append(result, publication{Path: filepath.Join(options.AppsDir, "grigdesk.desktop"),
				Mode: 0o644, Bytes: []byte(text)})
		}
	}
	if pointer.Server != nil {
		result = append(result, serviceRegistration(options, receipt))
	}
	if options.Descriptor != "" {
		// Окно получает каталог команд из проверенного current при каждом запуске.
		content, _ := installation.JSONBytes(map[string]any{
			"version": 5, "kind": "installed", "root": options.Root,
			"installationId": receipt.InstallationID, "home": receipt.DataHome,
			"cliPaths": []string{},
		})
		result = append(result, publication{Path: options.Descriptor, Mode: 0o600, Bytes: content})
	}
	return result
}

func serviceRegistration(options Options, receipt installation.Receipt) publication {
	if runtime.GOOS == "darwin" {
		return launchAgent(options, receipt)
	}
	text := fmt.Sprintf("# GrigDesk installationId=%s\n[Unit]\nDescription=GrigDesk\nAfter=network.target\n"+
		"StartLimitIntervalSec=0\n[Service]\nType=simple\nExecStart=%q\nWorkingDirectory=%q\nEnvironment=%q\n"+
		"EnvironmentFile=-%q\nRestart=always\nRestartPreventExitStatus=78\nRestartSec=5\nKillMode=mixed\n"+
		"TimeoutStopSec=60\n[Install]\nWantedBy=default.target\n",
		receipt.InstallationID, filepath.Join(options.Root, "bin", "grigdesk-server"),
		options.Root, "GRIGDESK_HOME="+receipt.DataHome, filepath.Join(receipt.DataHome, ".env"))
	return publication{Path: filepath.Join(options.UnitDir, "grigdesk-server.service"), Mode: 0o600, Bytes: []byte(text)}
}

func safeBundleLink(relative, target string) bool {
	if target == "" || filepath.IsAbs(target) || strings.ContainsRune(target, 0) {
		return false
	}
	name := filepath.Clean(filepath.Join(filepath.Dir(relative), target))
	prefix, _, found := strings.Cut(relative, "/grigdesk.app/")
	return found && (name == prefix+"/grigdesk.app" || strings.HasPrefix(name, prefix+"/grigdesk.app/"))
}

func samePointer(a, b installation.Pointer) bool {
	left, _ := installation.JSONBytes(a)
	right, _ := installation.JSONBytes(b)
	return bytes.Equal(left, right)
}
