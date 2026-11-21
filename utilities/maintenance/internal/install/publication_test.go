package install

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"

	"grigdesk.local/tools/utilities/internal/installation"
)

func TestPublicationChild(t *testing.T) {
	intent := os.Getenv("GRIGDESK_PUBLICATION_FIXTURE")
	if intent == "" {
		return
	}
	data, err := os.ReadFile(intent)
	if err != nil {
		t.Fatal(err)
	}
	var saved preparation
	if err := json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	err = publishAt(context.Background(), saved, intent, func(point string) {
		if point == os.Getenv("GRIGDESK_PUBLICATION_CHECKPOINT") {
			_ = syscall.Kill(os.Getpid(), syscall.SIGKILL)
		}
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestPublicationSurvivesSIGKILL(t *testing.T) {
	for _, point := range []string{
		"root", "before-external-0", "after-external-0", "before-external-1", "after-external-1",
		"before-current", "after-current",
	} {
		t.Run(point, func(t *testing.T) {
			base, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			stage := filepath.Join(base, ".staging")
			root := filepath.Join(base, "program")
			data := filepath.Join(base, "data")
			intent := root + ".installing.json"
			for _, dir := range []string{stage, data} {
				if err := os.Mkdir(dir, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			sentinel := filepath.Join(data, "sentinel")
			if err := os.WriteFile(sentinel, []byte("D"), 0o600); err != nil {
				t.Fatal(err)
			}
			parentInfo, _ := os.Stat(base)
			stageInfo, _ := os.Stat(stage)
			files, err := verifyTree(stage, nil)
			if err != nil {
				t.Fatal(err)
			}
			saved := preparation{
				Options: Options{Root: root, DataHome: data, UserData: filepath.Join(base, "profile")},
				Stage:   stage, StageID: installation.FileIdentity(stageInfo),
				ParentID: installation.FileIdentity(parentInfo), Files: files,
				Pointer: installation.Pointer{InstallationID: installation.UUID(), Format: 2},
				Outputs: []publication{
					{Path: filepath.Join(base, "bin", "launcher"), Bytes: []byte("launcher"), Mode: 0o755},
					{Path: filepath.Join(base, "units", "unit"), Bytes: []byte("unit"), Mode: 0o600},
				},
			}
			if err := publishJSON(intent, saved); err != nil {
				t.Fatal(err)
			}
			command := exec.Command(os.Args[0], "-test.run=^TestPublicationChild$")
			command.Env = append(os.Environ(), "GRIGDESK_PUBLICATION_FIXTURE="+intent,
				"GRIGDESK_PUBLICATION_CHECKPOINT="+point)
			output, err := command.CombinedOutput()
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.Sys().(syscall.WaitStatus).Signal() != syscall.SIGKILL {
				t.Fatalf("ожидался SIGKILL на %s: %v %s", point, err, output)
			}
			current := filepath.Join(root, "current.json")
			if _, err := os.Stat(current); (err == nil) != (point == "after-current") {
				t.Fatalf("видимость current на %s: %v", point, err)
			}
			command = exec.Command(os.Args[0], "-test.run=^TestPublicationChild$")
			command.Env = append(os.Environ(), "GRIGDESK_PUBLICATION_FIXTURE="+intent)
			if output, err := command.CombinedOutput(); err != nil {
				t.Fatalf("продолжение: %v %s", err, output)
			}
			want, _ := installation.JSONBytes(saved.Pointer)
			got, err := os.ReadFile(current)
			rootInfo, rootErr := os.Stat(root)
			d, dataErr := os.ReadFile(sentinel)
			if err != nil || string(got) != string(want) || rootErr != nil ||
				!os.SameFile(rootInfo, stageInfo) || dataErr != nil || string(d) != "D" {
				t.Fatalf("после продолжения изменились установка или D: %s %s", got, d)
			}
		})
	}
}
