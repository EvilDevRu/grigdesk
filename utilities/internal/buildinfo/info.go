package buildinfo

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"runtime"
	"slices"
	"syscall"
)

//go:embed project-license.txt
var projectLicense string

//go:embed go-license.txt
var goLicense string

type Info struct {
	Schema  int    `json:"schema"`
	Kind    string `json:"kind"`
	Version string `json:"version"`
	Runtime string `json:"runtime"`
	Go      string `json:"go"`
	OS      string `json:"os"`
	Arch    string `json:"arch"`
}

// Write записывает отдельный JSON-ответ о бинарнике до любых внешних действий.
// Версию и имя передаёт конкретная команда, платформа берётся из среды Go.
func Write(out io.Writer, kind, version string) error {
	return json.NewEncoder(out).Encode(Info{
		Schema:  1,
		Kind:    kind,
		Version: version,
		Runtime: "go",
		Go:      runtime.Version(),
		OS:      runtime.GOOS,
		Arch:    runtime.GOARCH,
	})
}

// Local обрабатывает общие флаги метаданных по точному числу аргументов.
// Команда сама определяет доступность лицензии и обработку остальных аргументов.
func Local(out io.Writer, args []string, kind, version string, license bool) (int, bool) {
	var err error
	switch {
	case slices.Equal(args, []string{"--runtime-info", "--json"}):
		err = Write(out, kind, version)
	case slices.Equal(args, []string{"--version"}):
		_, err = fmt.Fprintf(out, "%s %s (Go %s, %s %s)\n", kind, version,
			runtime.Version(), runtime.GOOS, runtime.GOARCH)
	case license && slices.Equal(args, []string{"--license"}):
		_, err = io.WriteString(out, projectLicense+"\n"+goLicense)
	default:
		return 0, false
	}

	if err != nil && !errors.Is(err, syscall.EPIPE) {
		return 1, true
	}

	return 0, true
}
