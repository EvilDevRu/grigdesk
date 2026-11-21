package install

import (
	"encoding/json"
	"errors"

	"grigdesk.local/tools/utilities/internal/processidentity"
)

func proveLeaseIdle(data []byte) error {
	var lease struct {
		Process struct {
			PID       int    `json:"pid"`
			Starttime string `json:"starttime"`
		} `json:"process"`
	}
	if json.Unmarshal(data, &lease) != nil || lease.Process.PID <= 0 || lease.Process.Starttime == "" {
		return errors.New("release_go_migration_busy")
	}
	start, dead := processidentity.Start(lease.Process.PID)
	if !dead && (start == "" || start == lease.Process.Starttime) {
		return errors.New("release_go_migration_busy")
	}
	return nil
}
