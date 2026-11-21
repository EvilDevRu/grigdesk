package update

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"slices"
	"time"

	"grigdesk.local/tools/utilities/internal/installation"
	"grigdesk.local/tools/utilities/internal/processidentity"
)

func drainServer(ctx context.Context, layout *installation.Layout, job *Job, saved *Handoff) error {
	if saved.Server == nil {
		return nil
	}
	current, err := inspectServer(ctx, layout, job.Previous.Server)
	if err != nil {
		return err
	}
	if current == nil {
		return verifyDrain(layout, job, saved.Server)
	}
	if *current != *saved.Server || saved.Activity == nil {
		return errors.New("release_server_owner_changed")
	}
	now, err := activity(ctx, layout)
	if err != nil {
		return err
	}
	if now.Active > saved.Activity.Active || now.Queued > saved.Activity.Queued ||
		slices.ContainsFunc(now.Tasks, func(task string) bool { return !slices.Contains(saved.Activity.Tasks, task) }) {
		return errors.New("release_activity_changed_confirm_again")
	}
	if err := stopPipelines(ctx, layout, now.Tasks); err != nil {
		return err
	}
	switch current.Owner {
	case "service":
		if err := stopPlatformService(ctx, layout); err != nil {
			return err
		}
	case "manual", "desktop":
		request := map[string]string{
			"jobId": job.ID, "installationId": job.InstallationID, "manifestDigest": job.Digest,
		}
		var response map[string]json.RawMessage
		if err := serverRequest(ctx, layout, http.MethodPost, "/api/system/update-drain",
			request, http.StatusAccepted, &response); err != nil || len(response) != 1 || string(response["ok"]) != "true" {
			return errors.New("release_server_drain_not_accepted")
		}
	default:
		return errors.New("release_server_owner_invalid")
	}
	bounded, cancel := context.WithTimeout(ctx, 55*time.Second)
	defer cancel()
	for {
		birth, dead := processidentity.Start(current.PID)
		if dead || birth != "" && birth != current.Process.Starttime {
			break
		}
		if !pauseUntil(bounded, 200*time.Millisecond) {
			return errors.New("release_server_drain_timeout")
		}
	}
	if err := verifyDrain(layout, job, current); err != nil {
		return err
	}
	owner, err := inspectServer(ctx, layout, job.Previous.Server)
	if err != nil || owner != nil {
		return errors.New("release_server_still_running")
	}
	return nil
}

func stopPipelines(ctx context.Context, layout *installation.Layout, ids []string) error {
	bounded, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	for _, id := range ids {
		var result struct {
			Outcome string `json:"outcome"`
		}
		if err := serverRequest(bounded, layout, http.MethodPost, "/api/tasks/"+id+"/stop",
			struct{}{}, http.StatusOK, &result); err != nil ||
			!slices.Contains([]string{"stopped", "not_running", "stop_sent"}, result.Outcome) {
			return errors.New("release_pipeline_stop_failed")
		}
	}
	for len(ids) > 0 {
		state, err := activity(bounded, layout)
		if err != nil {
			return err
		}
		if !slices.ContainsFunc(state.Tasks, func(task string) bool { return slices.Contains(ids, task) }) {
			return nil
		}
		if !pauseUntil(bounded, 300*time.Millisecond) {
			return errors.New("release_pipeline_stop_failed")
		}
	}
	return nil
}

func verifyDrain(layout *installation.Layout, job *Job, owner *serverOwner) error {
	if owner == nil {
		return nil
	}
	content, err := layout.ReadPrivate("update/server-drain.json")
	var proof struct {
		JobID    string `json:"jobId"`
		Nonce    string `json:"nonce"`
		Instance string `json:"instanceId"`
		Success  bool   `json:"success"`
	}
	if err != nil || job.Intent == nil || !closed(content, &proof, "jobId", "nonce", "instanceId", "success") ||
		proof.JobID != job.ID || proof.Nonce != job.Intent.Nonce || proof.Instance != owner.InstanceID || !proof.Success {
		return errors.New("release_server_drain_proof_missing")
	}
	return nil
}

func registerServerBoot(layout *installation.Layout, job *Job, manifest installation.Manifest, owner *serverOwner) error {
	content, err := installation.JSONBytes(map[string]any{
		"jobId": job.ID, "nonce": job.Intent.Nonce, "installationId": job.InstallationID,
		"version": manifest.Version, "releaseId": manifest.ReleaseID, "process": owner.Process,
		"instanceId": owner.InstanceID,
	})
	if err != nil {
		return err
	}
	return installation.ReplaceState(filepath.Join(layout.Receipt.Root, "update", "server-boot.json"), content)
}
