package host

import (
	"io"
	"os"
	"path/filepath"
)

// TrustedReadCommand читает control с проверкой того же DACL, что у движка.
// Node получает проверенные байты, а режим Unix не используется как подмена ACL.
func TrustedReadCommand(args []string, out io.Writer) (bool, int) {
	if len(args) == 0 || args[0] != "_windows-read-protected" {
		return false, 0
	}
	if len(args) != 3 || !filepath.IsAbs(args[2]) || filepath.Clean(args[2]) != args[2] {
		return true, 2
	}
	kind, name := args[1], args[2]
	path, err := filepath.EvalSymlinks(name)
	if err != nil || path != name {
		return true, 78
	}
	options := FileOptions(0)
	switch kind {
	case "directory":
		options = Directory
	case "file", "immutable", "owner":
	default:
		return true, 2
	}
	file, err := OpenPath(name, os.O_RDONLY, 0, options)
	if err != nil {
		return true, 78
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return true, 78
	}
	if options == Directory {
		if info.IsDir() && PrivateMode(file, info, 0700) {
			return true, 0
		}
		return true, 78
	}
	const limit = 16 * 1024 * 1024
	if !info.Mode().IsRegular() || !SingleLink(file, info) || info.Size() > limit ||
		!trustedReadMode(file, info, kind) {
		return true, 78
	}
	raw, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(raw)) != info.Size() {
		return true, 78
	}
	current, err := os.Lstat(name)
	if err != nil || !os.SameFile(info, current) || current.ModTime() != info.ModTime() ||
		!SingleLink(file, current) || !trustedReadMode(file, current, kind) {
		return true, 78
	}
	if _, err := out.Write(raw); err != nil {
		return true, 74
	}

	return true, 0
}

func trustedReadMode(file *os.File, info os.FileInfo, kind string) bool {
	return (kind != "owner" && PrivateMode(file, info, 0400)) ||
		(kind != "immutable" && PrivateMode(file, info, 0600))
}
