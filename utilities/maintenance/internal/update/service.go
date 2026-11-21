package update

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"time"

	"grigdesk.local/tools/utilities/internal/installation"
)

const jobPath = "update/job.json"

type latestRelease func(context.Context, string) (installation.Manifest, []byte, error)

type Service struct {
	Layout *installation.Layout
	latest latestRelease
}

type Check struct {
	State     string          `json:"state"`
	CheckedAt *string         `json:"checkedAt"`
	Error     *string         `json:"error"`
	Envelope  json.RawMessage `json:"envelope"`
	Digest    *string         `json:"manifestDigest"`
}

type Status struct {
	Channel      string             `json:"channel"`
	Source       string             `json:"source"`
	Mode         string             `json:"mode"`
	Installed    map[string]*string `json:"installed"`
	Check        Check              `json:"check"`
	Job          *Job               `json:"job"`
	WorkerActive bool               `json:"workerActive"`
}

func (service Service) Action(ctx context.Context, action string, input []byte) (any, error) {
	if err := service.Layout.VerifyTrust(); err != nil {
		return nil, err
	}
	if action == "status" {
		if !schemaOnly(input) {
			return nil, InvalidRequest()
		}
		return service.Status()
	}
	lockPath := filepath.Join(service.Layout.Receipt.Root, "update", "installation.install-lock")
	if err := installation.CheckParents(filepath.Dir(lockPath)); err != nil {
		return nil, err
	}
	unlock, err := installation.AcquireLock(lockPath)
	if err != nil {
		return nil, errors.New("release_update_in_progress")
	}
	defer unlock()
	return service.runLocked(ctx, action, input)
}

func schemaOnly(input []byte) bool {
	var request struct {
		Schema int `json:"schema"`
	}
	return closed(input, &request, "schema") && request.Schema == 1
}

func (service Service) runLocked(ctx context.Context, action string, input []byte) (any, error) {
	switch action {
	case "check":
		if !schemaOnly(input) {
			return nil, InvalidRequest()
		}
		return service.check(ctx)
	case "set-channel":
		var request struct {
			Schema  int    `json:"schema"`
			Channel string `json:"channel"`
		}
		if !closed(input, &request, "schema", "channel") || request.Schema != 1 ||
			!slices.Contains([]string{"release", "dev"}, request.Channel) {
			return nil, InvalidRequest()
		}
		return service.setChannel(request.Channel)
	case "create-job":
		var request createRequest
		if !closed(input, &request, "schema", "requestId", "manifestDigest", "scope") ||
			request.Schema != 1 || !uuid.MatchString(request.ID) || !sha.MatchString(request.Digest) ||
			!validScope(service.Layout.Receipt.Mode, request.Scope) {
			return nil, InvalidRequest()
		}
		return service.create(ctx, request)
	case "prepare", "apply", "recover":
		var request struct {
			Schema int    `json:"schema"`
			Job    string `json:"jobId"`
		}
		if !closed(input, &request, "schema", "jobId") || request.Schema != 1 || !uuid.MatchString(request.Job) {
			return nil, InvalidRequest()
		}
		return service.process(ctx, action, request.Job)
	case "handoff":
		return service.handoff(ctx, input)
	case "resume-handoff":
		return service.resumeHandoff(ctx, input)
	case "boot-proof":
		return service.bootProof(ctx, input)
	}
	return nil, InvalidRequest()
}

func (service Service) Status() (Status, error) {
	layout := service.Layout
	pointer, err := layout.Current()
	if err != nil {
		return Status{}, err
	}
	if pointer.Format != 2 {
		return Status{}, errors.New("release_go_migration_pending")
	}
	job, _, err := readJob(layout, jobPath)
	if err != nil {
		return Status{}, err
	}
	status := Status{
		Channel: layout.Receipt.Channel, Source: layout.Receipt.Source, Mode: layout.Receipt.Mode,
		Installed: map[string]*string{"desktop": nil, "server": nil, "control": nil},
		Job:       job, Check: Check{State: "unknown"},
	}
	if layout.Receipt.Format == 1 {
		status.Source = "channel"
	}
	for _, part := range []string{"control", "desktop", "server"} {
		if installed := pointerVersion(component(pointer, part)); installed != "" {
			status.Installed[part] = &installed
		}
	}
	data, err := layout.ReadPrivate("update/check.json")
	if err == nil {
		var cache struct {
			Channel string `json:"channel"`
			Check   Check  `json:"check"`
		}
		if json.Unmarshal(data, &cache) != nil {
			return Status{}, errors.New("release_check_cache_invalid")
		}
		if cache.Channel == status.Channel {
			if cache.Check.Digest != nil {
				manifest, err := layout.VerifyEnvelope(cache.Check.Envelope)
				if err != nil || manifest.Digest != *cache.Check.Digest || manifest.Channel != status.Channel {
					return Status{}, errors.New("release_check_cache_invalid")
				}
				if cache.Check.State != "error" {
					cache.Check.State = availability(layout, pointer, manifest)
				}
			}
			status.Check = cache.Check
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return Status{}, err
	}
	return status, nil
}

func availability(layout *installation.Layout, pointer installation.Pointer, manifest installation.Manifest) string {
	if manifest.Format != 3 || installation.CompareVersions(manifest.Version, pointer.Floor) < 0 {
		return "current"
	}
	scope := map[string]string{"local": "pair", "server": "server", "remote": "desktop"}[layout.Receipt.Mode]
	if err := verifyTarget(layout, pointer, manifest, scope); err != nil {
		return "current"
	}
	return "available"
}

func (service Service) check(ctx context.Context) (Status, error) {
	state, err := service.Status()
	if err != nil {
		return Status{}, err
	}
	if state.Source != "channel" {
		return Status{}, errors.New("candidate_source_required")
	}
	manifest, envelope, err := service.lookup(ctx)
	checked := now()
	check := state.Check
	check.CheckedAt = &checked
	if err != nil {
		code := "release_channel_unavailable"
		check.State, check.Error = "error", &code
	} else {
		pointer, err := service.Layout.Current()
		if err != nil {
			return Status{}, err
		}
		check.State = availability(service.Layout, pointer, manifest)
		check.Envelope, check.Digest, check.Error = envelope, &manifest.Digest, nil
	}
	content, err := installation.JSONBytes(map[string]any{"channel": state.Channel, "check": check})
	if err != nil {
		return Status{}, err
	}
	if err := installation.ReplaceState(filepath.Join(service.Layout.Receipt.Root, "update", "check.json"), content); err != nil {
		return Status{}, err
	}
	state.Check = check
	return state, nil
}

func (service Service) setChannel(channel string) (Status, error) {
	layout := service.Layout
	if layout.Receipt.Format != 1 {
		return Status{}, errors.New("candidate_source_required")
	}
	job, _, err := readJob(layout, jobPath)
	if err != nil {
		return Status{}, err
	}
	if job != nil && slices.Contains(pending, job.Stage) {
		return Status{}, errors.New("release_update_in_progress")
	}
	receipt := layout.Receipt
	receipt.Channel = channel
	data, err := installation.JSONBytes(receipt)
	if err != nil {
		return Status{}, err
	}
	if err := installation.ReplaceState(filepath.Join(receipt.Root, "installation.json"), data); err != nil {
		return Status{}, err
	}
	layout.Receipt = receipt
	return service.Status()
}

func (service Service) create(ctx context.Context, request createRequest) (*Job, error) {
	layout := service.Layout
	active, _, err := readJob(layout, jobPath)
	if err != nil {
		return nil, err
	}
	if active != nil && active.Request == request.ID {
		if err := remember(layout, active); err != nil {
			return nil, err
		}
		return repeat(active, request)
	}
	old, _, err := readJob(layout, "update/requests/"+request.ID+".json")
	if err != nil {
		return nil, err
	}
	if old != nil {
		return repeat(old, request)
	}
	if active != nil && slices.Contains(pending, active.Stage) {
		return nil, errors.New("release_update_in_progress")
	}
	if active != nil {
		if err := remember(layout, active); err != nil {
			return nil, err
		}
	}
	manifest, envelope, err := service.lookup(ctx)
	if err != nil {
		return nil, err
	}
	if manifest.Format != 3 || manifest.Digest != request.Digest {
		return nil, errors.New("release_target_changed")
	}
	pointer, err := layout.Current()
	if err != nil {
		return nil, err
	}
	if err := verifyTarget(layout, pointer, manifest, request.Scope); err != nil {
		return nil, err
	}
	job := &Job{
		Format: 2, ID: installation.UUID(), Request: request.ID, InstallationID: layout.Receipt.InstallationID,
		Digest: manifest.Digest, Scope: request.Scope, Envelope: envelope, Previous: pointer,
		Target: targetPointer(pointer, request.Scope, manifest.Version), Stage: "queued", Created: now(),
	}
	if err := save(layout, job); err != nil {
		return nil, err
	}
	if err := remember(layout, job); err != nil {
		return nil, err
	}
	return job, nil
}

func verifyTarget(layout *installation.Layout, pointer installation.Pointer, target installation.Manifest, scope string) error {
	arch := map[string]string{"amd64": "x64", "arm64": "arm64"}[runtime.GOARCH]
	if pointer.Format != 2 || target.Platform.OS != runtime.GOOS || target.Platform.Arch != arch ||
		installation.CompareVersions(target.Version, pointer.Floor) < 0 {
		return errors.New("release_not_newer")
	}
	newer := false
	selected := scopes(scope)
	var identities = make(map[string]installation.Manifest)
	for _, part := range []string{"control", "desktop", "server"} {
		current := component(pointer, part)
		if current == nil {
			continue
		}
		active, err := layout.Manifest(*current, part)
		if err != nil || active.Format != 3 {
			return errors.New("release_generation_identity_invalid")
		}
		identities[part] = active
		if !slices.Contains(selected, part) {
			continue
		}
		comparison := installation.CompareVersions(target.Version, active.Version)
		if comparison < 0 || comparison == 0 && target.Digest != active.Digest {
			return errors.New("release_not_newer")
		}
		if comparison > 0 && part != "control" {
			newer = true
		}
		identities[part] = target
	}
	if !newer {
		return errors.New("release_not_newer")
	}
	if desktop, ok := identities["desktop"]; ok {
		if server, local := identities["server"]; local && (server.ServerAPI.Major != desktop.DesktopRequires.Major ||
			server.ServerAPI.Minor < desktop.DesktopRequires.MinMinor) {
			return errors.New("pair_update_required")
		}
	}
	return nil
}

func (service Service) lookup(ctx context.Context) (installation.Manifest, []byte, error) {
	if service.latest != nil {
		return service.latest(ctx, service.Layout.Receipt.Channel)
	}
	if service.Layout.Receipt.Format != 1 {
		return installation.Manifest{}, nil, errors.New("candidate_source_required")
	}
	for _, origin := range []string{"https://grigdesk.com", "https://grigdesk.ru"} {
		address := fmt.Sprintf("%s/api/releases/v1/%s.json", origin, service.Layout.Receipt.Channel)
		content, err := fetchIndex(ctx, address)
		if err != nil {
			continue
		}
		manifest, envelope, err := installation.SignedIndex(content)
		if err == nil && manifest.Channel == service.Layout.Receipt.Channel {
			return manifest, envelope, nil
		}
	}
	return installation.Manifest{}, nil, errors.New("release_channel_unavailable")
}

func fetchIndex(ctx context.Context, address string) ([]byte, error) {
	client := http.Client{
		Timeout: 5 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	const limit = 1 << 20
	if response.StatusCode != http.StatusOK {
		return nil, errors.New("release_channel_unavailable")
	}
	bytes, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || len(bytes) > limit {
		return nil, errors.New("release_channel_invalid")
	}
	return bytes, nil
}

// PrepareOffline повторяет то же подписанное задание под update lock.
// Стабильный helper B остаётся владельцем регистрации после подготовки C.
func (service Service) PrepareOffline(ctx context.Context, source string, manifest installation.Manifest,
	envelope []byte) (*Job, error) {
	layout := service.Layout
	if source != "" {
		if err := layout.VerifyInstaller(source, manifest.Digest); err != nil {
			return nil, err
		}
	} else if layout.Receipt.Format != 1 {
		return nil, errors.New("candidate_source_required")
	}
	verified, err := layout.VerifyEnvelope(envelope)
	if err != nil || verified.Digest != manifest.Digest || verified.Channel != layout.Receipt.Channel {
		return nil, errors.New("installation_release_trust_mismatch")
	}
	helper, err := layout.Maintenance()
	if err != nil {
		return nil, err
	}
	defer helper.Close()
	unlock, err := installation.AcquireLock(filepath.Join(layout.Receipt.Root, "update", "installation.install-lock"))
	if err != nil {
		return nil, errors.New("release_update_in_progress")
	}
	defer unlock()
	scope := map[string]string{"local": "pair", "server": "server", "remote": "desktop"}[layout.Receipt.Mode]
	active, _, err := readJob(layout, jobPath)
	if err != nil {
		return nil, err
	}
	request := createRequest{Schema: 1, ID: installation.UUID(), Digest: verified.Digest, Scope: scope}
	if active != nil && active.Digest == request.Digest && active.Scope == request.Scope {
		request.ID = active.Request
	}
	service.latest = func(context.Context, string) (installation.Manifest, []byte, error) {
		return verified, envelope, nil
	}
	job, err := service.create(ctx, request)
	if err != nil {
		return nil, err
	}
	return service.prepareFromSource(ctx, job, manifest, source)
}
