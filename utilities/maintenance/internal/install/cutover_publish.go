package install

import (
	"context"
	"errors"
	"os"
	"path/filepath"

	"grigdesk.local/tools/utilities/internal/installation"
)

func advanceCutover(ctx context.Context, layout *installation.Layout, state cutoverIntent,
	intentPath string, checkpoint func(string)) error {
	root := layout.Receipt.Root
	currentPath := filepath.Join(root, "current.json")
	helperPath := filepath.Join(root, "update", "maintenance")
	current, err := layout.ReadPrivate("current.json")
	if err != nil {
		return err
	}
	helper, err := installation.ProveFile(helperPath)
	if err != nil {
		return err
	}
	target, err := installation.JSONBytes(state.TargetCurrent)
	if err != nil {
		return err
	}
	phase, err := observed(state.ExpectedHelper, state.TargetHelper.SHA256,
		state.ExpectedCurrent, installation.Hash(target), helper.SHA256, installation.Hash(current))
	if err != nil {
		return err
	}
	stage := cutoverStage(root, state)
	if phase == "prepared" {
		if err := proveCutoverIdle(ctx, layout, state); err != nil {
			return err
		}
		if err := ensureGeneration(layout, state, stage); err != nil {
			return err
		}
		checkpoint("before-helper")
		if err := replaceLegacyHelper(filepath.Join(stage, "update", "maintenance"), helperPath, helper, state); err != nil {
			return err
		}
		checkpoint("after-helper")
		phase = "helper_active"
	}
	if phase == "helper_active" {
		if err := bindMigrationHelper(root, state); err != nil {
			return err
		}
		state.Stage = phase
		if err := writeCutoverState(intentPath, state); err != nil {
			return err
		}
		if err := quarantineLegacy(ctx, root, state, checkpoint); err != nil {
			return err
		}
		if err := proveCutoverIdle(ctx, layout, state); err != nil {
			return err
		}
		if err := ensureGeneration(layout, state, stage); err != nil {
			return err
		}
		latest, err := layout.ReadPrivate("current.json")
		if err != nil || installation.Hash(latest) != state.ExpectedCurrent {
			return errors.New("release_cutover_identity_mismatch")
		}
		checkpoint("before-current")
		if err := installation.ReplaceState(currentPath, target); err != nil {
			return err
		}
		checkpoint("after-current")
	}
	current, err = layout.ReadPrivate("current.json")
	if err != nil || installation.Hash(current) != installation.Hash(target) {
		return errors.New("release_cutover_identity_mismatch")
	}
	if err := bindMigrationHelper(root, state); err != nil {
		return err
	}
	state.Stage = "generation_active"
	return writeCutoverState(intentPath, state)
}

func ensureGeneration(layout *installation.Layout, state cutoverIntent, stage string) error {
	relative := *state.TargetCurrent.Control
	root := layout.Receipt.Root
	destination := filepath.Join(root, relative)
	info, err := os.Lstat(destination)
	if errors.Is(err, os.ErrNotExist) {
		if err := installation.MoveOwnedDirectory(filepath.Join(stage, relative), destination,
			state.TargetGeneration); err != nil {
			return err
		}
		info, err = os.Lstat(destination)
	}
	if err != nil || !info.IsDir() || installation.FileIdentity(info) != state.TargetGeneration {
		return errors.New("release_cutover_generation_mismatch")
	}
	for _, part := range []struct {
		name string
		path *string
	}{{"control", state.TargetCurrent.Control}, {"server", state.TargetCurrent.Server},
		{"desktop", state.TargetCurrent.Desktop}} {
		if part.path == nil {
			continue
		}
		manifest, err := layout.Manifest(*part.path, part.name)
		if err != nil || manifest.Digest != state.TargetDigest || manifest.Format != 3 {
			return errors.New("release_cutover_generation_mismatch")
		}
		if err := checkComponent(root, *part.path, manifest.Artifacts[part.name]); err != nil {
			return err
		}
	}
	return nil
}

func replaceLegacyHelper(stage, helper string, previous installation.FileProof, state cutoverIntent) error {
	staged, err := installation.ProveFile(stage)
	if err != nil || staged != state.TargetHelper {
		return errors.New("release_cutover_helper_mismatch")
	}
	current, err := installation.ProveFile(helper)
	if err != nil || current != previous || current.SHA256 != state.ExpectedHelper {
		return errors.New("release_cutover_helper_mismatch")
	}
	if err := os.Rename(stage, helper); err != nil {
		return err
	}
	if err := installation.SyncDirectory(filepath.Dir(helper)); err != nil {
		return err
	}
	published, err := installation.ProveFile(helper)
	if err != nil || published != staged {
		return errors.New("release_cutover_helper_mismatch")
	}
	return installation.SyncDirectory(filepath.Dir(stage))
}

func bindMigrationHelper(root string, state cutoverIntent) error {
	proof, err := installation.ProveFile(filepath.Join(root, "update", "maintenance"))
	if err != nil || proof != state.TargetHelper {
		return errors.New("release_cutover_helper_mismatch")
	}
	return publishJSON(filepath.Join(root, "update", "maintenance.json"), map[string]any{
		"schema": 1, "installationId": state.InstallationID, "size": proof.Size, "sha256": proof.SHA256,
	})
}

func quarantineLegacy(ctx context.Context, root string, state cutoverIntent, checkpoint func(string)) error {
	directory := filepath.Join(root, "update", "go-cutover", state.TargetVersion)
	if err := installation.CheckParents(directory); err != nil {
		return err
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	for _, old := range state.Legacy {
		if err := ctx.Err(); err != nil {
			return err
		}
		source := filepath.Join(root, "generations", old.Version)
		target := filepath.Join(directory, old.Version)
		if _, err := os.Lstat(source); err == nil {
			if err := confirmLegacy(source, old); err != nil {
				return err
			}
			if err := installation.MoveOwnedDirectory(source, target, old.Identity); err != nil {
				return err
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err := confirmLegacy(target, old); err != nil {
			return err
		}
		checkpoint("quarantined-" + old.Version)
	}
	return nil
}

func confirmLegacy(directory string, old oldGeneration) error {
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || installation.FileIdentity(info) != old.Identity {
		return errors.New("release_cutover_legacy_identity_mismatch")
	}
	_, err = verifyTree(directory, old.Files)
	return err
}

func writeCutoverState(path string, state cutoverIntent) error {
	content, err := installation.JSONBytes(state)
	if err != nil {
		return err
	}
	return installation.ReplaceState(path, content)
}
