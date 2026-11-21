package update

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"

	"grigdesk.local/tools/utilities/internal/installation"
	"grigdesk.local/tools/utilities/maintenance/internal/install"
)

func (service Service) process(ctx context.Context, action, id string) (*Job, error) {
	layout := service.Layout
	job, manifest, err := readJob(layout, jobPath)
	if err != nil {
		return nil, err
	}
	if job == nil || job.ID != id {
		return nil, errors.New("update_job_mismatch")
	}
	switch action {
	case "prepare":
		return service.prepare(ctx, job, manifest)
	case "apply", "recover":
		return service.apply(ctx, job, manifest)
	default:
		return nil, InvalidRequest()
	}
}

func (service Service) prepare(ctx context.Context, job *Job, manifest installation.Manifest) (*Job, error) {
	return service.prepareFromSource(ctx, job, manifest, "")
}

func (service Service) prepareFromSource(ctx context.Context, job *Job, manifest installation.Manifest,
	source string) (*Job, error) {
	layout := service.Layout
	if job.Stage == "ready" {
		return job, nil
	}
	if !slices.Contains([]string{"queued", "verifying", "downloading", "preparing", "failed"}, job.Stage) {
		return nil, errors.New("release_prepare_not_available")
	}
	current, err := layout.Current()
	if err != nil || !equalPointers(current, job.Previous) {
		return nil, errors.New("release_update_pointer_changed")
	}
	if err := verifyTarget(layout, current, manifest, job.Scope); err != nil {
		return nil, err
	}
	if err := saveStage(layout, job, "preparing", nil); err != nil {
		return nil, err
	}
	if err := service.stage(ctx, job, manifest, source); err != nil {
		_ = saveStage(layout, job, "failed", &JobError{Code: err.Error(), NextAction: "resume-update"})
		return nil, err
	}
	return job, saveStage(layout, job, "ready", nil)
}

func saveStage(layout *installation.Layout, job *Job, stage string, failure *JobError) error {
	job.Stage = stage
	job.Error = failure
	job.Progress = nil
	return save(layout, job)
}

func (service Service) stage(ctx context.Context, job *Job, manifest installation.Manifest, source string) error {
	root := service.Layout.Receipt.Root
	work := filepath.Join(root, "update", job.ID)
	if err := installation.CheckParents(work); err != nil {
		return err
	}
	if err := os.MkdirAll(work, 0o700); err != nil {
		return err
	}
	for _, name := range scopes(job.Scope) {
		relative := *component(job.Target, name)
		target := filepath.Join(root, relative)
		testPath := target
		if name == "control" {
			testPath = filepath.Join(testPath, "bin")
		}
		if _, err := os.Lstat(testPath); err == nil {
			active, err := service.Layout.Manifest(relative, name)
			if err != nil || active.Digest != manifest.Digest || verifyInventory(target, active.Artifacts[name]) != nil {
				return errors.New("release_target_generation_conflict")
			}
			continue
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		stage := filepath.Join(work, name)
		if err := ensureStaged(ctx, stage, name, manifest, source); err != nil {
			return err
		}
		if err := probe(ctx, work, stage, name, manifest); err != nil {
			return err
		}
	}
	return nil
}

func ensureStaged(ctx context.Context, destination, name string, manifest installation.Manifest, source string) error {
	if info, err := os.Lstat(destination); err == nil {
		if !info.IsDir() {
			return errors.New("release_target_generation_conflict")
		}
		return verifyInventory(destination, manifest.Artifacts[name])
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	stage, err := os.MkdirTemp(filepath.Dir(destination), "."+name+"-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	if err := installation.StageArtifact(ctx, source, stage, name, manifest); err != nil {
		return err
	}
	if name == "desktop" && runtime.GOOS == "darwin" {
		if err := install.MaterializeMacDesktop(ctx, stage); err != nil {
			return err
		}
	}
	info, err := os.Lstat(stage)
	if err != nil {
		return err
	}
	return installation.MoveOwnedDirectory(stage, destination, installation.FileIdentity(info))
}

func verifyInventory(directory string, artifact installation.Artifact) error {
	for _, item := range artifact.Files {
		file := filepath.Join(directory, item.Path)
		if err := installation.CheckParents(filepath.Dir(file)); err != nil {
			return err
		}
		proof, err := installation.ProveFile(file)
		mode := uint32(0o444)
		if item.Mode&0o111 != 0 {
			mode = 0o555
		}
		if err != nil || proof.Size != item.Size || proof.Mode != mode || proof.SHA256 != item.SHA256 {
			return errors.New("release_file_hash_mismatch")
		}
	}
	return nil
}

func probe(ctx context.Context, work, directory, name string, manifest installation.Manifest) error {
	binary, args := "GrigDesk", []string{"--grigdesk-release-probe"}
	if name == "desktop" && runtime.GOOS == "darwin" {
		if err := install.VerifyMacDesktop(ctx, directory); err != nil {
			return err
		}
		binary = "grigdesk.app/Contents/MacOS/grigdesk"
	}
	switch name {
	case "control":
		binary, args = "bin/grigdesk-ctl", []string{"--runtime-info", "--json"}
	case "server":
		binary, args = "bin/grigdesk-server", []string{"--version", "--json"}
	}
	home, err := os.MkdirTemp(work, ".probe-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(home)
	limit, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	file := filepath.Join(directory, binary)
	env := []string{"HOME=" + home, "GRIGDESK_HOME=" + home, "PATH=/usr/bin:/bin", "LANG=C.UTF-8"}
	if name == "desktop" && runtime.GOOS == "linux" {
		appDir, err := extractProbeAppImage(limit, file, home, env)
		if err != nil {
			return errors.New("release_component_probe_invalid")
		}
		if appDir != "" {
			env = append(env, "APPIMAGE="+file, "APPDIR="+appDir, "TMPDIR="+home)
			file = filepath.Join(appDir, "AppRun")
		}
	}
	command := exec.CommandContext(limit, file, args...)
	command.Dir, command.Env = home, env
	var output boundedBuffer
	command.Stdout = &output
	if err := command.Run(); err != nil {
		return errors.New("release_component_probe_invalid")
	}
	var observed struct {
		Version string          `json:"version"`
		Package string          `json:"packageId"`
		Release string          `json:"releaseId"`
		Kind    string          `json:"kind"`
		Runtime json.RawMessage `json:"runtime"`
	}
	if json.Unmarshal(output, &observed) != nil || observed.Version != manifest.Version ||
		name == "server" && observed.Package != manifest.Artifacts[name].PackageID ||
		name == "desktop" && observed.Release != manifest.ReleaseID {
		return errors.New("release_component_probe_invalid")
	}
	if name == "control" {
		// Одиночный сервер выдаёт объект Node runtime, а ctl подтверждает строку "go".
		var runtime string
		if json.Unmarshal(observed.Runtime, &runtime) != nil ||
			observed.Kind != "grigdesk-ctl" || runtime != "go" {
			return errors.New("release_component_probe_invalid")
		}
	}
	return nil
}

// extractProbeAppImage распаковывает проверенный type-2 AppImage в HOME пробы.
// Вывод распаковщика отделён от обязательного JSON identity в stdout AppRun.
func extractProbeAppImage(ctx context.Context, file, home string, env []string) (string, error) {
	input, err := os.Open(file)
	if err != nil {
		return "", err
	}
	var header [11]byte
	n, _ := input.ReadAt(header[:], 0)
	if err := input.Close(); err != nil {
		return "", err
	}
	if n != len(header) || string(header[:4]) != "\x7fELF" || string(header[8:]) != "AI\x02" {
		return "", nil
	}

	extract := exec.CommandContext(ctx, file, "--appimage-extract")
	extract.Dir, extract.Env = home, append(env, "TMPDIR="+home)
	if err := extract.Run(); err != nil {
		return "", err
	}

	dir := filepath.Join(home, "squashfs-root")
	if physical, err := filepath.EvalSymlinks(dir); err != nil || physical != dir {
		return "", errors.New("release_appimage_probe_root_invalid")
	}
	run, err := filepath.EvalSymlinks(filepath.Join(dir, "AppRun"))
	if err != nil || !strings.HasPrefix(run, dir+string(filepath.Separator)) {
		return "", errors.New("release_appimage_probe_entry_invalid")
	}
	return dir, nil
}

type boundedBuffer []byte

func (buffer *boundedBuffer) Write(data []byte) (int, error) {
	if len(*buffer)+len(data) > 1<<16 {
		return 0, errors.New("release_component_probe_output_limit")
	}
	*buffer = append(*buffer, data...)
	return len(data), nil
}
