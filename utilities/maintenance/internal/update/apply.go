package update

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"grigdesk.local/tools/utilities/internal/installation"
	"grigdesk.local/tools/utilities/internal/processidentity"
)

var errReleaseOwnerActive = errors.New("release_update_owner_active")
var errReleaseOwnerScanUnresolved = errors.New("release_process_owner_invalid")

type Process struct {
	PID        int    `json:"pid"`
	Starttime  string `json:"starttime"`
	Executable string `json:"executable"`
}

type Handoff struct {
	JobID          string                 `json:"jobId"`
	Nonce          string                 `json:"nonce"`
	InstallationID string                 `json:"installationId"`
	Digest         string                 `json:"manifestDigest"`
	Desktop        *Process               `json:"desktop"`
	StopLocal      bool                   `json:"stopLocal"`
	RemoteAPI      *installation.APIRange `json:"remoteApi"`
	Server         *serverOwner           `json:"server"`
	Activity       *serverActivity        `json:"activity"`
}

func (service Service) handoff(ctx context.Context, input []byte) (*Handoff, error) {
	var request struct {
		Schema    int                    `json:"schema"`
		JobID     string                 `json:"jobId"`
		Desktop   *Process               `json:"desktop"`
		StopLocal bool                   `json:"stopLocal"`
		RemoteAPI *installation.APIRange `json:"remoteApi"`
	}
	if !closed(input, &request, "schema", "jobId", "desktop", "stopLocal", "remoteApi") ||
		request.Schema != 1 || !uuid.MatchString(request.JobID) {
		return nil, InvalidRequest()
	}
	if request.RemoteAPI != nil {
		var fields map[string]json.RawMessage
		_ = json.Unmarshal(input, &fields)
		if !closed(fields["remoteApi"], request.RemoteAPI, "major", "minor") {
			return nil, InvalidRequest()
		}
	}
	layout := service.Layout
	job, manifest, err := readJob(layout, jobPath)
	if err != nil {
		return nil, err
	}
	if job == nil || job.ID != request.JobID || job.Stage != "ready" ||
		(request.Desktop == nil) != (job.Scope == "server") ||
		job.Scope != "desktop" && !request.StopLocal ||
		job.Scope == "desktop" && layout.Receipt.Mode == "remote" && request.StopLocal {
		return nil, errors.New("release_handoff_invalid")
	}
	current, err := layout.Current()
	if err != nil || !equalPointers(current, job.Previous) {
		return nil, errors.New("release_update_pointer_changed")
	}
	if request.Desktop != nil {
		if !validOwner(ctx, layout.Receipt.Root, *job.Previous.Desktop, *request.Desktop) {
			return nil, errors.New("release_handoff_invalid")
		}
	}
	if job.Scope == "desktop" {
		if request.RemoteAPI == nil || request.RemoteAPI.Major != manifest.DesktopRequires.Major ||
			request.RemoteAPI.Minor < manifest.DesktopRequires.MinMinor {
			return nil, errors.New("release_remote_api_incompatible")
		}
	}
	if job.Intent != nil {
		return existingHandoff(layout, job)
	}
	var owner *serverOwner
	var observed *serverActivity
	if request.StopLocal {
		owner, err = inspectServer(ctx, layout, current.Server)
		if err != nil {
			return nil, err
		}
		if owner != nil {
			snapshot, err := activity(ctx, layout)
			if err != nil {
				return nil, err
			}
			observed = &snapshot
		}
	}
	job.Intent = &Intent{Nonce: installation.UUID(), ConfirmedAt: now()}
	bound := &Handoff{
		JobID: job.ID, Nonce: job.Intent.Nonce, InstallationID: job.InstallationID,
		Digest: job.Digest, Desktop: request.Desktop, StopLocal: request.StopLocal, RemoteAPI: request.RemoteAPI,
		Server: owner, Activity: observed,
	}
	if err := saveHandoff(layout, bound); err != nil {
		return nil, err
	}
	return bound, save(layout, job)
}

func saveHandoff(layout *installation.Layout, bound *Handoff) error {
	data, err := installation.JSONBytes(bound)
	if err != nil {
		return err
	}
	return installation.ReplaceState(filepath.Join(layout.Receipt.Root, "update", "handoff.json"), data)
}

// resumeHandoff привязывает восстановление к новому владельцу того же desktop под общим lock.
func (service Service) resumeHandoff(ctx context.Context, input []byte) (*Handoff, error) {
	var request struct {
		Schema  int     `json:"schema"`
		JobID   string  `json:"jobId"`
		Desktop Process `json:"desktop"`
	}
	if !closed(input, &request, "schema", "jobId", "desktop") ||
		request.Schema != 1 || !uuid.MatchString(request.JobID) {
		return nil, InvalidRequest()
	}
	layout := service.Layout
	job, _, err := readJob(layout, jobPath)
	if err != nil {
		return nil, err
	}
	if job == nil || job.ID != request.JobID || job.Scope == "server" || job.Previous.Desktop == nil ||
		!slices.Contains([]string{"stopping", "applying", "starting", "manual_recovery_required"}, job.Stage) ||
		!validOwner(ctx, layout.Receipt.Root, *job.Previous.Desktop, request.Desktop) {
		return nil, errors.New("release_recovery_not_available")
	}
	active, err := layout.Current()
	if err != nil || !equalPointers(active, job.Previous) {
		return nil, errors.New("release_update_pointer_changed")
	}
	saved, err := existingHandoff(layout, job)
	if err != nil {
		return nil, err
	}
	if saved.Desktop != nil && *saved.Desktop != request.Desktop {
		birth, dead := processidentity.Start(saved.Desktop.PID)
		if !dead && (birth == "" || birth == saved.Desktop.Starttime) {
			return nil, errors.New("release_desktop_owner_active")
		}
	}
	saved.Desktop = &request.Desktop
	marker := filepath.Join(layout.Receipt.Root, "update", "worker.json")
	if err := os.Remove(marker); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err := saveHandoff(layout, saved); err != nil {
		return nil, err
	}
	return saved, nil
}

func existingHandoff(layout *installation.Layout, job *Job) (*Handoff, error) {
	if job.Intent == nil {
		return nil, errors.New("release_user_consent_required")
	}
	data, err := layout.ReadPrivate("update/handoff.json")
	var saved Handoff
	if err != nil || !closed(data, &saved, "jobId", "nonce", "installationId", "manifestDigest",
		"desktop", "stopLocal", "remoteApi", "server", "activity") ||
		saved.JobID != job.ID || saved.Nonce != job.Intent.Nonce || saved.InstallationID != job.InstallationID ||
		saved.Digest != job.Digest || (saved.Desktop == nil) != (job.Scope == "server") ||
		(saved.Server == nil) != (saved.Activity == nil) ||
		saved.Server != nil && (!saved.StopLocal || saved.Server.InstallationID != job.InstallationID) {
		return nil, errors.New("release_handoff_invalid")
	}
	return &saved, nil
}

func (service Service) apply(ctx context.Context, job *Job, manifest installation.Manifest) (*Job, error) {
	layout := service.Layout
	saved, err := existingHandoff(layout, job)
	if err != nil {
		return nil, err
	}
	active, err := layout.Current()
	if err != nil {
		return nil, err
	}
	if equalPointers(active, job.Target) {
		if job.Stage == "completed" {
			return job, nil
		}
		return job, saveStage(layout, job, "applied_not_started", &JobError{
			Code: "release_boot_proof_required", NextAction: "resume-update",
		})
	}
	if !equalPointers(active, job.Previous) || !slices.Contains([]string{"ready", "applying", "stopping"}, job.Stage) {
		return nil, errors.New("release_update_pointer_changed")
	}
	if saved.Desktop != nil {
		birth, dead := processidentity.Start(saved.Desktop.PID)
		if !dead && (birth == "" || birth == saved.Desktop.Starttime) {
			return nil, errors.New("release_desktop_owner_active")
		}
	}
	if err := awaitPreviousOwnersStopped(ctx, layout, job, saved); err != nil {
		return nil, err
	}
	if err := verifyDrain(layout, job, saved.Server); err != nil {
		return nil, err
	}
	if err := saveStage(layout, job, "applying", nil); err != nil {
		return nil, err
	}
	if err := publishGeneration(ctx, layout, job, manifest); err != nil {
		return nil, err
	}
	confirmed, err := layout.Current()
	if err != nil || !equalPointers(confirmed, job.Previous) {
		return nil, errors.New("release_update_pointer_changed")
	}
	content, err := installation.JSONBytes(job.Target)
	if err != nil {
		return nil, err
	}
	if err := installation.ReplaceState(filepath.Join(layout.Receipt.Root, "current.json"), content); err != nil {
		return nil, err
	}
	return job, saveStage(layout, job, "applied_not_started", &JobError{
		Code: "release_boot_proof_required", NextAction: "resume-update",
	})
}

// awaitPreviousOwnersStopped даёт закрыться launcher после выхода его рабочего процесса.
// При гонке с закрытием FUSE нужен повторный полный обход, прежде чем менять указатель.
func awaitPreviousOwnersStopped(ctx context.Context, layout *installation.Layout, job *Job, saved *Handoff) error {
	bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for {
		err := previousOwnersStopped(bounded, layout, job, saved)
		if err != errReleaseOwnerActive && err != errReleaseOwnerScanUnresolved {
			return err
		}
		if !pauseUntil(bounded, 100*time.Millisecond) {
			return err
		}
	}
}

func publishGeneration(ctx context.Context, layout *installation.Layout, job *Job, manifest installation.Manifest) error {
	root := layout.Receipt.Root
	generation := filepath.Join(root, *job.Target.Control)
	if err := installation.CheckParents(generation); err != nil {
		return err
	}
	if err := os.MkdirAll(generation, 0o700); err != nil {
		return err
	}
	release := filepath.Join(generation, "release.json")
	if proof, err := installation.ProveFile(release); err == nil {
		existing, err := layout.Manifest(*job.Target.Control, "control")
		if err != nil || existing.Digest != job.Digest || proof.Mode != 0o600 {
			return errors.New("release_target_generation_conflict")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	} else if err := installation.PublishFile(release, append(slices.Clone(job.Envelope), '\n'), 0o600); err != nil {
		return err
	}
	for _, name := range scopes(job.Scope) {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := publishPart(layout, job, manifest, name); err != nil {
			return err
		}
	}
	return nil
}

func publishPart(layout *installation.Layout, job *Job, manifest installation.Manifest, name string) error {
	root := layout.Receipt.Root
	artifact := manifest.Artifacts[name]
	directory := filepath.Join(root, *component(job.Target, name))
	source := filepath.Join(root, "update", job.ID, name)
	if name == "control" {
		source = filepath.Join(source, "bin")
		directory = filepath.Join(directory, "bin")
		file := artifact.Files[0]
		file.Path = strings.TrimPrefix(file.Path, "bin/")
		artifact.Files = []installation.File{file}
	}
	if _, err := os.Lstat(directory); errors.Is(err, os.ErrNotExist) {
		info, err := os.Lstat(source)
		if err != nil || !info.IsDir() {
			return errors.New("release_staged_generation_missing")
		}
		if err := verifyInventory(source, artifact); err != nil {
			return err
		}
		if err := installation.MoveOwnedDirectory(source, directory, installation.FileIdentity(info)); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	return verifyInventory(directory, artifact)
}

func (service Service) bootProof(ctx context.Context, input []byte) (*Job, error) {
	var request struct {
		Schema    int     `json:"schema"`
		JobID     string  `json:"jobId"`
		Nonce     string  `json:"nonce"`
		Version   string  `json:"version"`
		ReleaseID string  `json:"releaseId"`
		Process   Process `json:"process"`
	}
	if !closed(input, &request, "schema", "jobId", "nonce", "version", "releaseId", "process") || request.Schema != 1 {
		return nil, InvalidRequest()
	}
	layout := service.Layout
	job, manifest, err := readJob(layout, jobPath)
	if err != nil {
		return nil, err
	}
	if job == nil || job.Intent == nil || request.JobID != job.ID || request.Nonce != job.Intent.Nonce ||
		request.Version != manifest.Version || request.ReleaseID != manifest.ReleaseID ||
		job.Stage != "applied_not_started" {
		return nil, errors.New("release_boot_proof_invalid")
	}
	current, err := layout.Current()
	if err != nil || !equalPointers(current, job.Target) {
		return nil, errors.New("release_update_pointer_changed")
	}
	owner := job.Target.Desktop
	if job.Scope == "server" {
		owner = job.Target.Server
	}
	if owner == nil || !validOwner(ctx, layout.Receipt.Root, *owner, request.Process) {
		return nil, errors.New("release_boot_proof_invalid")
	}
	if job.Scope == "pair" {
		server, err := inspectServer(ctx, layout, job.Target.Server)
		if err != nil || server == nil {
			return nil, errors.New("release_server_boot_proof_missing")
		}
		if err := registerServerBoot(layout, job, manifest, server); err != nil {
			return nil, err
		}
	}
	proof, err := installation.JSONBytes(map[string]any{
		"jobId": job.ID, "nonce": job.Intent.Nonce, "installationId": job.InstallationID,
		"version": request.Version, "releaseId": request.ReleaseID, "process": request.Process,
	})
	if err != nil {
		return nil, err
	}
	if err := installation.ReplaceState(filepath.Join(layout.Receipt.Root, "update", "desktop-boot.json"), proof); err != nil {
		return nil, err
	}
	return job, saveStage(layout, job, "completed", nil)
}
