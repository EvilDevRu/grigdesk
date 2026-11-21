//go:build unix

package hooks

import (
	"path/filepath"
	"strings"
)

func profileShell() (string, error) {
	return "bash", nil
}

func validCheckoutPath(item string) bool {
	return filepath.IsAbs(item) && filepath.Clean(item) == item && item != "/" &&
		!strings.ContainsAny(item, " :\t\r\n\"\\")
}
