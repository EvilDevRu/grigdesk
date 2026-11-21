package install

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"grigdesk.local/tools/utilities/internal/installation"
)

type oldGeneration struct {
	Version   string                            `json:"version"`
	ReleaseID string                            `json:"releaseId"`
	Digest    string                            `json:"digest"`
	Identity  installation.Identity             `json:"identity"`
	Files     map[string]installation.FileProof `json:"files"`
}

type cutoverIntent struct {
	Schema           int                    `json:"schema"`
	InstallationID   string                 `json:"installationId"`
	Mode             string                 `json:"mode"`
	TargetVersion    string                 `json:"targetVersion"`
	TargetReleaseID  string                 `json:"targetReleaseId"`
	TargetDigest     string                 `json:"targetDigest"`
	ExpectedCurrent  string                 `json:"expectedCurrentSha"`
	ExpectedHelper   string                 `json:"expectedOldHelperSha"`
	TargetHelper     installation.FileProof `json:"targetHelper"`
	TargetCurrent    installation.Pointer   `json:"targetCurrent"`
	TargetGeneration installation.Identity  `json:"targetGeneration"`
	BeforeControl    *string                `json:"beforeControl"`
	Stage            string                 `json:"stage"`
	StageDirectory   string                 `json:"stageDirectory"`
	Legacy           []oldGeneration        `json:"legacy"`
}

func migration(ctx context.Context, layout *installation.Layout, options Options, release selectedRelease) error {
	root := layout.Receipt.Root
	updateDir := filepath.Join(root, "update")
	if err := installation.CheckParents(updateDir); err != nil {
		return err
	}
	unlock, err := installation.AcquireLock(filepath.Join(updateDir, "installation.install-lock"))
	if err != nil {
		return errors.New("release_go_migration_busy")
	}
	defer unlock()
	intentPath := filepath.Join(updateDir, "go-cutover.json")
	state, err := loadCutover(layout, release)
	if errors.Is(err, os.ErrNotExist) {
		if !options.Migrate || options.Expected == "" {
			return errors.New("release_go_migration_required")
		}
		state, err = prepareCutover(ctx, layout, options, release, intentPath)
	}
	if err != nil {
		return err
	}
	if options.Expected != "" && options.Expected != state.ExpectedCurrent {
		return errors.New("release_cutover_consent_mismatch")
	}
	return advanceCutover(ctx, layout, state, intentPath, func(string) {})
}

func loadCutover(layout *installation.Layout, release selectedRelease) (cutoverIntent, error) {
	state, err := readCutover(layout)
	if err != nil {
		return cutoverIntent{}, err
	}
	if state.TargetDigest != release.Manifest.Digest || state.TargetVersion != release.Manifest.Version ||
		state.TargetReleaseID != release.Manifest.ReleaseID {
		return cutoverIntent{}, errors.New("release_cutover_intent_conflict")
	}
	return state, nil
}

// readCutover проверяет журнал независимо от версии следующего дистрибутива.
func readCutover(layout *installation.Layout) (cutoverIntent, error) {
	raw, err := layout.ReadPrivate("update/go-cutover.json")
	if err != nil {
		return cutoverIntent{}, err
	}
	var state cutoverIntent
	if json.Unmarshal(raw, &state) != nil || state.Schema != 1 ||
		state.InstallationID != layout.Receipt.InstallationID || state.Mode != layout.Receipt.Mode ||
		!installation.ValidVersion(state.TargetVersion) || state.BeforeControl != nil ||
		!samePointer(state.TargetCurrent, newPointer(layout.Receipt, state.TargetVersion)) ||
		filepath.Base(state.StageDirectory) != state.StageDirectory ||
		!strings.HasPrefix(state.StageDirectory, ".go-stage-"+state.TargetVersion+"-") ||
		!slices.Contains([]string{"prepared", "helper_active", "generation_active"}, state.Stage) ||
		len(state.Legacy) == 0 || len(state.Legacy) > 2 {
		return cutoverIntent{}, errors.New("release_cutover_intent_conflict")
	}
	seen := make(map[string]bool)
	for _, old := range state.Legacy {
		if !installation.ValidVersion(old.Version) || seen[old.Version] ||
			installation.CompareVersions(old.Version, state.TargetVersion) >= 0 ||
			old.Identity.Ino == 0 || len(old.Files) == 0 {
			return cutoverIntent{}, errors.New("release_cutover_intent_invalid")
		}
		seen[old.Version] = true
	}
	return state, nil
}

func prepareCutover(ctx context.Context, layout *installation.Layout, options Options,
	release selectedRelease, intentPath string) (cutoverIntent, error) {
	raw, err := layout.ReadPrivate("current.json")
	if err != nil || installation.Hash(raw) != options.Expected {
		return cutoverIntent{}, errors.New("release_cutover_consent_mismatch")
	}
	current, err := layout.Current()
	if err != nil || current.Format != 1 {
		return cutoverIntent{}, errors.New("release_cutover_source_invalid")
	}
	receipt := layout.Receipt
	targetReceipt, err := installation.NewReceipt(receipt)
	if err != nil || targetReceipt != receipt || release.Manifest.Channel != receipt.Channel {
		return cutoverIntent{}, errors.New("installation_release_trust_mismatch")
	}
	state := cutoverIntent{
		Schema: 1, InstallationID: receipt.InstallationID, Mode: receipt.Mode,
		TargetVersion: release.Manifest.Version, TargetReleaseID: release.Manifest.ReleaseID,
		TargetDigest: release.Manifest.Digest, ExpectedCurrent: options.Expected,
		TargetCurrent: newPointer(receipt, release.Manifest.Version), Stage: "prepared",
	}
	if err := legacyGenerations(layout, current, &state); err != nil {
		return cutoverIntent{}, err
	}
	if err := proveCutoverIdle(ctx, layout, state); err != nil {
		return cutoverIntent{}, err
	}
	old, err := installation.ProveFile(filepath.Join(receipt.Root, "update", "maintenance"))
	if err != nil || old.Mode&0o100 == 0 {
		return cutoverIntent{}, errors.New("release_cutover_source_invalid")
	}
	state.ExpectedHelper = old.SHA256
	stage, err := os.MkdirTemp(filepath.Join(receipt.Root, "update"), ".go-stage-"+state.TargetVersion+"-")
	if err != nil {
		return cutoverIntent{}, err
	}
	state.StageDirectory = filepath.Base(stage)
	retain := false
	defer func() {
		if !retain {
			_ = os.RemoveAll(stage)
		}
	}()
	if err := stageFiles(ctx, stage, options.Source, release, receipt, state.TargetCurrent); err != nil {
		return cutoverIntent{}, err
	}
	state.TargetHelper, err = installation.ProveFile(filepath.Join(stage, "update", "maintenance"))
	if err != nil {
		return cutoverIntent{}, err
	}
	info, err := os.Stat(filepath.Join(stage, *state.TargetCurrent.Control))
	if err != nil {
		return cutoverIntent{}, err
	}
	state.TargetGeneration = installation.FileIdentity(info)
	if err := installation.SyncDirectory(stage); err != nil {
		return cutoverIntent{}, err
	}
	if err := publishJSON(intentPath, state); err != nil {
		return cutoverIntent{}, err
	}
	retain = true
	return state, nil
}

func legacyGenerations(layout *installation.Layout, pointer installation.Pointer, state *cutoverIntent) error {
	seen := make(map[string]bool)
	for _, part := range []struct {
		name string
		path *string
	}{{"desktop", pointer.Desktop}, {"server", pointer.Server}} {
		if part.path == nil {
			continue
		}
		manifest, err := layout.Manifest(*part.path, part.name)
		if err != nil || manifest.Format != 2 || manifest.Channel != layout.Receipt.Channel ||
			installation.CompareVersions(manifest.Version, state.TargetVersion) >= 0 {
			return errors.New("release_cutover_source_invalid")
		}
		for _, file := range manifest.Artifacts[part.name].Files {
			physical := filepath.Join(layout.Receipt.Root, *part.path, file.Path)
			proof, err := installation.ProveFile(physical)
			if err != nil || proof.Size != file.Size || proof.SHA256 != file.SHA256 ||
				(proof.Mode != file.Mode && proof.Mode != file.Mode&0o555) {
				return errors.New("release_cutover_source_invalid")
			}
		}
		if seen[manifest.Version] {
			continue
		}
		seen[manifest.Version] = true
		path := filepath.Join(layout.Receipt.Root, "generations", manifest.Version)
		info, err := os.Lstat(path)
		if err != nil || !info.IsDir() {
			return errors.New("release_cutover_source_invalid")
		}
		files, err := verifyTree(path, nil)
		if err != nil {
			return err
		}
		state.Legacy = append(state.Legacy, oldGeneration{
			Version: manifest.Version, ReleaseID: manifest.ReleaseID, Digest: manifest.Digest,
			Identity: installation.FileIdentity(info), Files: files,
		})
	}
	return nil
}

func cutoverStage(root string, state cutoverIntent) string {
	return filepath.Join(root, "update", state.StageDirectory)
}

func observed(oldHelper, newHelper, oldPointer, newPointer, helper, pointer string) (string, error) {
	switch {
	case helper == oldHelper && pointer == oldPointer:
		return "prepared", nil
	case helper == newHelper && pointer == oldPointer:
		return "helper_active", nil
	case helper == newHelper && pointer == newPointer:
		return "generation_active", nil
	default:
		return "", errors.New("release_cutover_identity_mismatch")
	}
}

func proveCutoverIdle(ctx context.Context, layout *installation.Layout, state cutoverIntent) error {
	for _, journal := range []string{"job.json", "prepare-process.json", "worker-process.json", "server-process.json"} {
		if err := proveCutoverJournal(layout, journal, state); err != nil {
			return err
		}
	}
	return censusLegacy(ctx, layout.Receipt.Root, state)
}

func proveCutoverJournal(layout *installation.Layout, filename string, state cutoverIntent) error {
	data, err := layout.ReadPrivate("update/" + filename)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return errors.New("release_go_migration_busy")
	}
	if filename != "job.json" {
		return proveLeaseIdle(data)
	}
	var job struct {
		InstallationID string `json:"installationId"`
		Stage          string `json:"stage"`
	}
	if json.Unmarshal(data, &job) != nil || job.InstallationID != state.InstallationID ||
		!slices.Contains([]string{"completed", "rolled_back", "failed"}, job.Stage) {
		return errors.New("release_go_migration_busy")
	}
	for _, old := range state.Legacy {
		if strings.Contains(string(data), "generations/"+old.Version+"/") {
			return errors.New("release_go_migration_busy")
		}
	}
	return nil
}
