package update

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"grigdesk.local/tools/utilities/internal/installation"
)

var uuid = regexp.MustCompile(`^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$`)
var sha = regexp.MustCompile(`^[a-f0-9]{64}$`)

var pending = []string{"queued", "verifying", "downloading", "preparing", "ready", "stopping",
	"applying", "starting", "applied_not_started", "manual_recovery_required"}

type Intent struct {
	Nonce       string `json:"nonce"`
	ConfirmedAt string `json:"confirmedAt"`
}

type JobError struct {
	Code       string `json:"code"`
	NextAction string `json:"nextAction"`
}

type Job struct {
	Format         int                  `json:"format"`
	ID             string               `json:"id"`
	Request        string               `json:"requestId"`
	InstallationID string               `json:"installationId"`
	Digest         string               `json:"manifestDigest"`
	Scope          string               `json:"scope"`
	Envelope       json.RawMessage      `json:"envelope"`
	Previous       installation.Pointer `json:"previous"`
	Target         installation.Pointer `json:"target"`
	Stage          string               `json:"stage"`
	Created        string               `json:"createdAt"`
	Updated        string               `json:"updatedAt"`
	Progress       *struct {
		Downloaded int64 `json:"downloadedBytes"`
		Total      int64 `json:"totalBytes"`
	} `json:"progress"`
	Error  *JobError `json:"error"`
	Intent *Intent   `json:"intent"`
}

type createRequest struct {
	Schema int    `json:"schema"`
	ID     string `json:"requestId"`
	Digest string `json:"manifestDigest"`
	Scope  string `json:"scope"`
}

func readJob(layout *installation.Layout, relative string) (*Job, installation.Manifest, error) {
	data, err := layout.ReadPrivate(relative)
	if errors.Is(err, os.ErrNotExist) {
		return nil, installation.Manifest{}, nil
	}
	if err != nil {
		return nil, installation.Manifest{}, err
	}
	var job Job
	if !closed(data, &job, "format", "id", "requestId", "installationId", "manifestDigest", "scope",
		"envelope", "previous", "target", "stage", "createdAt", "updatedAt", "progress", "error", "intent") ||
		job.Format != 2 || job.InstallationID != layout.Receipt.InstallationID ||
		!uuid.MatchString(job.ID) || !uuid.MatchString(job.Request) ||
		!slices.Contains(append(slices.Clone(pending), "failed", "completed"), job.Stage) ||
		!validScope(layout.Receipt.Mode, job.Scope) {
		return nil, installation.Manifest{}, errors.New("update_journal_invalid")
	}
	manifest, err := layout.VerifyEnvelope(job.Envelope)
	if err != nil || manifest.Format != 3 || manifest.Digest != job.Digest {
		return nil, installation.Manifest{}, errors.New("update_journal_invalid")
	}
	if !validPointer(job.Previous, layout.Receipt) || !validPointer(job.Target, layout.Receipt) ||
		!equalPointers(job.Target, targetPointer(job.Previous, job.Scope, manifest.Version)) {
		return nil, installation.Manifest{}, errors.New("update_journal_invalid")
	}
	if job.Intent != nil && (!uuid.MatchString(job.Intent.Nonce) || job.Intent.ConfirmedAt == "") {
		return nil, installation.Manifest{}, errors.New("update_journal_invalid")
	}
	return &job, manifest, nil
}

func validPointer(pointer installation.Pointer, receipt installation.Receipt) bool {
	if pointer.Format != 2 || pointer.InstallationID != receipt.InstallationID ||
		pointer.Control == nil || !installation.ValidVersion(pointer.Floor) {
		return false
	}
	for _, item := range []struct {
		path     *string
		name     string
		required bool
	}{{pointer.Control, "", true}, {pointer.Desktop, "/desktop", receipt.Mode != "server"},
		{pointer.Server, "/server", receipt.Mode != "remote"}} {
		if (item.path != nil) != item.required {
			return false
		}
		if item.path == nil {
			continue
		}
		version := pointerVersion(item.path)
		if !installation.ValidVersion(version) || *item.path != "generations/"+version+item.name ||
			installation.CompareVersions(version, pointer.Floor) < 0 {
			return false
		}
	}
	return true
}

func validScope(mode, scope string) bool {
	return scope == "pair" && mode == "local" ||
		scope == "server" && mode != "remote" || scope == "desktop" && mode != "server"
}

func scopes(scope string) []string {
	switch scope {
	case "desktop":
		return []string{"control", "desktop"}
	case "server":
		return []string{"control", "server"}
	default:
		return []string{"control", "desktop", "server"}
	}
}

func targetPointer(pointer installation.Pointer, scope, version string) installation.Pointer {
	root := "generations/" + version
	pointer.Control = &root
	if scope != "server" {
		desktop := root + "/desktop"
		pointer.Desktop = &desktop
	}
	if scope != "desktop" {
		server := root + "/server"
		pointer.Server = &server
	}
	return pointer
}

func pointerVersion(path *string) string {
	if path == nil {
		return ""
	}
	parts := strings.Split(*path, "/")
	if len(parts) < 2 {
		return ""
	}
	return parts[1]
}

func component(pointer installation.Pointer, name string) *string {
	switch name {
	case "control":
		return pointer.Control
	case "server":
		return pointer.Server
	default:
		return pointer.Desktop
	}
}

func equalPointers(a, b installation.Pointer) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

func save(layout *installation.Layout, job *Job) error {
	job.Updated = now()
	data, err := installation.JSONBytes(job)
	if err != nil {
		return err
	}
	return installation.ReplaceState(filepath.Join(layout.Receipt.Root, "update", "job.json"), data)
}

func remember(layout *installation.Layout, job *Job) error {
	directory := filepath.Join(layout.Receipt.Root, "update", "requests")
	if err := installation.CheckParents(directory); err != nil {
		return err
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	file := filepath.Join(directory, job.Request+".json")
	if _, err := os.Lstat(file); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	data, err := installation.JSONBytes(job)
	if err != nil {
		return err
	}
	return installation.PublishFile(file, data, 0o600)
}

func repeat(job *Job, request createRequest) (*Job, error) {
	if job.Request != request.ID || job.Digest != request.Digest || job.Scope != request.Scope {
		return nil, errors.New("request_conflict")
	}
	return job, nil
}

func now() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

func closed(content []byte, target any, fields ...string) bool {
	if _, err := installation.CanonicalJSON(content); err != nil {
		return false
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(content, &object) != nil || len(object) != len(fields) {
		return false
	}
	for _, name := range fields {
		if _, ok := object[name]; !ok {
			return false
		}
	}
	return json.Unmarshal(content, target) == nil
}

func InvalidRequest() error {
	return fmt.Errorf("maintenance_request_invalid")
}
