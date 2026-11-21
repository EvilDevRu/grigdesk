package local

import (
	_ "embed"
	"encoding/json"
	"path/filepath"
)

//go:embed packages.json
var catalog []byte

type Speaker struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Timbre string `json:"timbre"`
}

type Package struct {
	EngineID             string    `json:"engineId"`
	ID                   string    `json:"id"`
	Name                 string    `json:"name"`
	Language             string    `json:"language"`
	Timbre               string    `json:"timbre"`
	URL                  string    `json:"url"`
	ArchiveSHA256        string    `json:"archiveSha256"`
	ArchiveBytes         int64     `json:"archiveBytes"`
	ModelName            string    `json:"modelName"`
	ModelSHA256          string    `json:"modelSha256"`
	ConfigName           string    `json:"configName"`
	ConfigSHA256         string    `json:"configSha256"`
	SampleRate           int       `json:"sampleRate"`
	License              string    `json:"license"`
	Requirements         []string  `json:"requirements"`
	RequirementsIndexURL *string   `json:"requirementsIndexUrl"`
	FileName             string    `json:"fileName"`
	FileSHA256           string    `json:"fileSha256"`
	FileBytes            int64     `json:"fileBytes"`
	EngineBytes          int64     `json:"engineBytes"`
	Speakers             []Speaker `json:"speakers"`
}

// Packages читает закреплённые версии моделей, Python-пакетов и контрольные суммы.
// Каждый вызов получает отдельный DTO, который тест может подменить явной спецификацией.
func Packages() ([]Package, error) {
	var result []Package
	err := json.Unmarshal(catalog, &result)
	return result, err
}

func (pack Package) EngineRoot(root string) string {
	return filepath.Join(root, "engines", pack.EngineID)
}

func (pack Package) ModelRoot(root string) string {
	group := "models"
	if pack.EngineID == "piper" {
		group = "voices"
	}
	return filepath.Join(pack.EngineRoot(root), group, pack.ID)
}
