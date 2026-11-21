package installation

import (
	"errors"
	"os"
	"path/filepath"
)

func (executable *Executable) execPath() (string, error) {
	path, err := filepath.EvalSymlinks(executable.path)
	if err != nil || path != executable.path {
		return "", errors.New("release_executable_replaced")
	}
	observed, err := os.Lstat(path)
	if err != nil || !owned(observed) || !os.SameFile(observed, executable.info) ||
		observed.Mode() != executable.info.Mode() || observed.ModTime() != executable.info.ModTime() {
		return "", errors.New("release_executable_replaced")
	}
	return path, nil
}
