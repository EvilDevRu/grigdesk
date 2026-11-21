package update

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"grigdesk.local/tools/utilities/internal/installation"
	"grigdesk.local/tools/utilities/internal/processidentity"
)

type workerMarker struct {
	Job     string  `json:"jobId"`
	Process Process `json:"process"`
}

func publishWorker(layout *installation.Layout, job, marker string) error {
	pid := os.Getpid()
	start, dead := processidentity.Start(pid)
	exe, err := os.Executable()
	if err != nil || dead || start == "" ||
		exe != filepath.Join(layout.Receipt.Root, "update", "maintenance") {
		return errors.New("release_process_owner_invalid")
	}
	content, err := installation.JSONBytes(workerMarker{
		Job: job, Process: Process{PID: pid, Starttime: start, Executable: exe},
	})
	if err != nil {
		return err
	}
	return installation.ReplaceState(filepath.Join(layout.Receipt.Root, "update", marker), content)
}

func workerAlive(layout *installation.Layout, job *Job) bool {
	if job == nil {
		return false
	}
	marker := "prepare-process.json"
	switch job.Stage {
	case "queued", "verifying", "downloading", "preparing":
	case "stopping", "applying", "starting":
		marker = "worker-process.json"
	default:
		return false
	}
	data, err := layout.ReadPrivate("update/" + marker)
	var saved workerMarker
	if err != nil || json.Unmarshal(data, &saved) != nil || saved.Job != job.ID {
		return false
	}
	actual, err := observeProcess(context.Background(), saved.Process.PID)
	return err == nil && actual == saved.Process &&
		actual.Executable == filepath.Join(layout.Receipt.Root, "update", "maintenance")
}

type workerStatus struct {
	Job   string `json:"jobId"`
	Nonce string `json:"nonce"`
	State string `json:"state"`
	Error string `json:"error,omitempty"`
}

// Worker принимает сохранённый handoff, публикует связанный ACK и ждёт точный выход окна.
func (service Service) Worker(ctx context.Context, action, id string) error {
	if !uuid.MatchString(id) {
		return InvalidRequest()
	}
	layout := service.Layout
	root := layout.Receipt.Root
	unlock, err := installation.AcquireLock(filepath.Join(root, "update", "installation.install-lock"))
	if err != nil {
		return errors.New("release_update_in_progress")
	}
	defer unlock()
	job, manifest, err := readJob(layout, jobPath)
	if err != nil || job == nil || job.ID != id {
		return errors.New("update_job_mismatch")
	}
	if action == "prepare" {
		if err := publishWorker(layout, id, "prepare-process.json"); err != nil {
			return err
		}
		_, err := service.prepare(ctx, job, manifest)
		return err
	}
	saved, err := existingHandoff(layout, job)
	if err != nil {
		return err
	}
	if err := publishWorker(layout, id, "worker-process.json"); err != nil {
		return err
	}
	status := workerStatus{Job: id, Nonce: saved.Nonce}
	if err := workerTransition(ctx, layout, job, saved, status); err != nil {
		status.State, status.Error = "failed", err.Error()
		_ = writeWorkerStatus(root, status)
		return err
	}
	job, err = service.apply(ctx, job, manifest)
	if err != nil {
		status.State, status.Error = "failed", err.Error()
		_ = writeWorkerStatus(root, status)
		return err
	}
	if job.Stage == "applied_not_started" && (job.Scope == "pair" || job.Scope == "server" && saved.Server != nil) {
		if err := startServer(ctx, layout, job.Target.Server, true); err != nil {
			return err
		}
		server, err := inspectServer(ctx, layout, job.Target.Server)
		if err != nil || server == nil {
			return errors.New("release_server_boot_proof_missing")
		}
		if err := registerServerBoot(layout, job, manifest, server); err != nil {
			return err
		}
		if job.Scope == "server" {
			return saveStage(layout, job, "completed", nil)
		}
	}
	if job.Scope != "server" && job.Stage == "applied_not_started" {
		return launchUpdatedWindow(layout)
	}
	return nil
}

func workerTransition(ctx context.Context, layout *installation.Layout, job *Job, saved *Handoff,
	status workerStatus) error {
	active, err := layout.Current()
	if err != nil {
		return err
	}
	if equalPointers(active, job.Target) {
		return nil
	}
	if !equalPointers(active, job.Previous) {
		return errors.New("release_update_pointer_changed")
	}
	if saved.Desktop != nil && !validOwner(ctx, layout.Receipt.Root, *job.Previous.Desktop, *saved.Desktop) {
		birth, dead := processidentity.Start(saved.Desktop.PID)
		if !dead && (birth == "" || birth == saved.Desktop.Starttime) {
			return errors.New("release_desktop_owner_changed")
		}
	}
	if err := saveStage(layout, job, "stopping", nil); err != nil {
		return err
	}
	if err := drainServer(ctx, layout, job, saved); err != nil {
		return err
	}
	serverCheck := *job
	serverCheck.Scope = "server"
	if err := awaitPreviousOwnersStopped(ctx, layout, &serverCheck, saved); err != nil {
		return err
	}
	status.State = "drained"
	if err := writeWorkerStatus(layout.Receipt.Root, status); err != nil {
		return err
	}
	if saved.Desktop == nil {
		return nil
	}
	deadline, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		birth, dead := processidentity.Start(saved.Desktop.PID)
		if dead || birth != "" && birth != saved.Desktop.Starttime {
			return nil
		}
		select {
		case <-deadline.Done():
			return errors.New("release_desktop_owner_active")
		case <-tick.C:
		}
	}
}

func writeWorkerStatus(root string, status workerStatus) error {
	content, err := installation.JSONBytes(status)
	if err != nil {
		return err
	}
	return installation.ReplaceState(filepath.Join(root, "update", "worker.json"), content)
}

func launchUpdatedWindow(layout *installation.Layout) error {
	root := layout.Receipt.Root
	helper, err := layout.Maintenance()
	if err != nil {
		return err
	}
	defer helper.Close()
	file := filepath.Join(root, "update", "maintenance")
	command := exec.Command(file, "launch", "desktop")
	command.Dir = root
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}
