package service

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"time"

	"grigdesk.local/tools/utilities/internal/grigdeskapi"
)

type Link struct {
	Name  string `json:"name"`
	State string `json:"state"`
}

type RelayState struct {
	Links []Link `json:"links"`
}

func readLinks(ctx context.Context, settings Settings) []Link {
	data, err := os.ReadFile(settings.TokenPath)
	token := strings.TrimSpace(string(data))
	if err != nil || token == "" {
		return nil
	}
	bounded, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	headers := make(http.Header)
	headers.Set("X-GrigDesk-Token", token)
	response, err := grigdeskapi.Request(bounded, http.MethodGet, settings.Origin+"/api/mobile/status", nil,
		grigdeskapi.Policy{Header: headers, ReadLimit: func(int, http.Header) int64 { return 256 << 10 }})
	if err != nil || response.Status != 200 || response.Truncated {
		return nil
	}
	var doc struct {
		Relays []struct {
			Name *string `json:"name"`
			Link *struct {
				State json.RawMessage `json:"state"`
			} `json:"link"`
		} `json:"relays"`
	}
	if err := json.Unmarshal(response.Body, &doc); err != nil || doc.Relays == nil {
		return nil
	}
	links := make([]Link, 0, len(doc.Relays))
	for _, raw := range doc.Relays {
		if raw.Name == nil || raw.Link == nil || raw.Link.State == nil {
			return nil
		}
		state := ""
		_ = json.Unmarshal(raw.Link.State, &state)
		switch state {
		case "online", "connecting", "waiting_vpn", "offline", "error":
		default:
			state = "unknown"
		}
		links = append(links, Link{Name: Printable(*raw.Name), State: state})
	}
	return links
}
