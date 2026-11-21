package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestSlotsWithoutAllocator(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	profiles := filepath.Join(root, "profiles")
	profile := filepath.Join(profiles, "demo-profile")
	if err := os.MkdirAll(profile, 0700); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{
		"profile.sh": "PROFILE_NAME=demo-profile\n",
		"graph.json": `{"capabilities":["route-v2"]}`,
		"runners.env": "RUNNERS_SCHEMA=1\nCONFIG_REVISION=1\nRUNNERS_COVERAGE=required\n" +
			"PROJECT_RUNNER_PRIMARY=fixture\n",
	} {
		if err := os.WriteFile(filepath.Join(profile, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("HOME", root)
	t.Setenv("FACTORY_PROFILES_DIR", profiles)
	t.Setenv("STATE_DIR", filepath.Join(root, "state"))
	t.Setenv("FACTORY_FORBID_LIVE", "1")

	t.Run("slots", func(t *testing.T) {
		var out, diagnostic bytes.Buffer
		rc := Run([]string{"slots", "--profile", "demo-profile"}, &out, &diagnostic)
		expected := "{\"profile\":\"demo-profile\",\"supported\":false,\"used\":[],\"free\":[]}\n"
		if rc != 0 || out.String() != expected || diagnostic.Len() != 0 {
			t.Fatalf("slots: rc=%d stdout=%q stderr=%q", rc, out.String(), diagnostic.String())
		}
	})

	t.Run("list", func(t *testing.T) {
		var out, diagnostic bytes.Buffer
		rc := Run([]string{"list"}, &out, &diagnostic)
		if rc != 0 || out.Len() != 0 || diagnostic.Len() != 0 {
			t.Fatalf("list: rc=%d stdout=%q stderr=%q", rc, out.String(), diagnostic.String())
		}
	})

	t.Run("list_catalog_protocol", func(t *testing.T) {
		state := filepath.Join(root, "state")
		if err := os.MkdirAll(state, 0700); err != nil {
			t.Fatal(err)
		}
		for file, body := range map[string]string{
			"t1.pipeline": "RUN_PROTOCOL=2\nPROFILE=demo-profile\nROUTE=legacy\n",
			"t2.pipeline": "CATALOG_PROTOCOL=route-v2\nPROFILE=demo-profile\nROUTE=quick\n",
		} {
			if err := os.WriteFile(filepath.Join(state, file), []byte(body), 0600); err != nil {
				t.Fatal(err)
			}
		}

		var out, diagnostic bytes.Buffer
		rc := Run([]string{"list"}, &out, &diagnostic)
		if rc != 0 || out.String() != "#2 [demo-profile] route=quick\n" || diagnostic.Len() != 0 {
			t.Fatalf("list: rc=%d stdout=%q stderr=%q", rc, out.String(), diagnostic.String())
		}
	})
}
