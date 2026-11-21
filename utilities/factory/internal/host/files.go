package host

import (
	"path/filepath"
	"strings"
)

type FileOptions uint8

const (
	Directory FileOptions = 1 << iota
	Nonblocking
	ChangeMode
)

// PathsOverlap использует правила томов и разделителей текущей ОС.
// Подкаталог считается совпадающей областью даже при различном написании регистра Windows.
func PathsOverlap(first, second string) bool {
	inside := func(parent, child string) bool {
		relative, err := filepath.Rel(parent, child)
		return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
	}

	return inside(first, second) || inside(second, first)
}
