//go:build unix

package cli

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"syscall"
)

// readStatusCapability считывает закрытый обычный файл повторно с позиции 0.
// Значение никогда не передаётся в argv, окружение или диагностику.
func readStatusCapability(fd string) (string, error) {
	invalid := fmt.Errorf("неверный или отсутствующий дескриптор права запуска")
	original, err := strconv.Atoi(fd)
	if err != nil || original < 3 {
		return "", invalid
	}
	duplicate, err := syscall.Dup(original)
	if err != nil {
		return "", invalid
	}
	syscall.CloseOnExec(original)
	syscall.CloseOnExec(duplicate)
	file := os.NewFile(uintptr(duplicate), "status capability")
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 ||
		info.Size() < 2 || info.Size() > 4096 {
		return "", invalid
	}
	details, ok := info.Sys().(*syscall.Stat_t)
	if !ok || details.Nlink > 1 || details.Uid != uint32(os.Geteuid()) {
		return "", invalid
	}
	raw := make([]byte, info.Size())
	if n, err := file.ReadAt(raw, 0); (err != nil && !errors.Is(err, io.EOF)) || n != len(raw) {
		return "", invalid
	}
	token, present := strings.CutSuffix(string(raw), "\n")
	if !present || token == "" || strings.ContainsAny(token, "\n\r\x00") {
		return "", invalid
	}
	return token, nil
}
