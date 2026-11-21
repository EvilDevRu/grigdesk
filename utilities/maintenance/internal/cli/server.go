package cli

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"slices"
	"strconv"

	"grigdesk.local/tools/utilities/internal/installation"
	"grigdesk.local/tools/utilities/maintenance/internal/update"
)

func logOptions(args []string) (int, bool, error) {
	lines, follow := 100, false
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "-f", "--follow":
			follow = true
		case "-n", "--lines":
			i++
			if i == len(args) {
				return 0, false, update.InvalidRequest()
			}
			value, err := strconv.Atoi(args[i])
			if err != nil || value < 1 || value > 10000 || strconv.Itoa(value) != args[i] {
				return 0, false, update.InvalidRequest()
			}
			lines = value
		default:
			return 0, false, update.InvalidRequest()
		}
	}
	return lines, follow, nil
}

func serverUpdate(
	ctx context.Context, layout *installation.Layout, resume bool, args []string, stdout io.Writer,
) error {
	for _, flag := range args {
		if !slices.Contains([]string{"--restart", "--force", "--json"}, flag) {
			return update.InvalidRequest()
		}
	}
	service := update.Service{Layout: layout}
	status, err := service.Status()
	if err != nil {
		return err
	}
	if status.Mode != "server" {
		return errors.New("pair_update_required")
	}
	if status.Source != "channel" && !resume {
		return errors.New("candidate_source_required")
	}
	job := status.Job
	if !resume && (job == nil || job.Stage == "completed") {
		job, err = createServerUpdate(ctx, service)
		if err != nil || job == nil {
			if err != nil {
				return err
			}
			return printUpdate(ctx, layout, "status", map[string]any{"schema": 1}, stdout)
		}
	}
	if job == nil || job.Scope != "server" {
		return errors.New("release_job_missing")
	}
	if status.WorkerActive {
		return errors.New("release_update_in_progress")
	}
	if slices.Contains([]string{"queued", "verifying", "downloading", "preparing", "failed"}, job.Stage) {
		if status.Source != "channel" {
			return errors.New("candidate_source_required")
		}
		if err := service.Worker(ctx, "prepare", job.ID); err != nil {
			return err
		}
		status, err = service.Status()
		if err != nil || status.Job == nil || status.Job.ID != job.ID {
			return errors.New("release_job_mismatch")
		}
		job = status.Job
	}
	if !slices.Contains(args, "--restart") {
		return json.NewEncoder(stdout).Encode(job)
	}
	action := "recover"
	if job.Stage == "ready" {
		body, err := json.Marshal(map[string]any{
			"schema": 1, "jobId": job.ID, "desktop": nil, "stopLocal": true, "remoteApi": nil,
		})
		if err != nil {
			return err
		}
		if _, err := service.Action(ctx, "handoff", body); err != nil {
			return err
		}
		action = "apply"
	}
	if err := service.Worker(ctx, action, job.ID); err != nil {
		return err
	}
	return printUpdate(ctx, layout, "status", map[string]any{"schema": 1}, stdout)
}

func createServerUpdate(ctx context.Context, service update.Service) (*update.Job, error) {
	result, err := service.Action(ctx, "check", []byte(`{"schema":1}`))
	if err != nil {
		return nil, err
	}
	status := result.(update.Status)
	if status.Check.Error != nil {
		return nil, errors.New(*status.Check.Error)
	}
	if status.Check.State != "available" || status.Check.Digest == nil {
		return nil, nil
	}
	body, err := json.Marshal(map[string]any{
		"schema": 1, "requestId": installation.UUID(), "scope": "server", "manifestDigest": *status.Check.Digest,
	})
	if err != nil {
		return nil, err
	}
	result, err = service.Action(ctx, "create-job", body)
	if err != nil {
		return nil, err
	}
	return result.(*update.Job), nil
}
