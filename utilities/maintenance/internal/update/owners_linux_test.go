package update

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestHeldAppImageIdentity(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "GrigDesk")
	image := []byte("\x7fELF\x00\x00\x00\x00AI\x02")
	if err := os.WriteFile(path, image, 0555); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	fd := fmt.Sprintf("/proc/self/fd/%d", file.Fd())
	if !matchesHeldAppImage(fd, path) {
		t.Fatal("не подтверждён дескриптор AppImage")
	}
	if err := os.Rename(path, filepath.Join(dir, "held")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, image, 0555); err != nil {
		t.Fatal(err)
	}
	if matchesHeldAppImage(fd, path) {
		t.Fatal("совпадающие байты подменили удержанный inode")
	}
}
