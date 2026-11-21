package draft

import (
	"encoding/json"

	"grigdesk.local/tools/utilities/routes/internal/transfer"
)

type Snapshot struct {
	ID       string          `json:"id"`
	Revision int64           `json:"revision"`
	Routes   json.RawMessage `json:"routes"`
}

type Create struct {
	Kind        string `json:"kind"`
	Title       string `json:"title"`
	CatalogHash string `json:"catalogHash,omitempty"`
}

type Patch struct {
	ExpectedRevision int64       `json:"expectedRevision"`
	Operations       []Operation `json:"operations"`
}

type Operation struct {
	Kind         string          `json:"kind"`
	RouteID      *string         `json:"routeId,omitzero"`
	Route        json.RawMessage `json:"route,omitzero"`
	Bootstrap    json.RawMessage `json:"bootstrap,omitzero"`
	Prompts      json.RawMessage `json:"prompts,omitzero"`
	Presentation json.RawMessage `json:"presentation,omitzero"`
	Provenance   json.RawMessage `json:"provenance,omitzero"`
}

// Replacement строит одну операцию замены снимка с ревизией, предоставленной человеком.
// Удаления идут перед добавлениями, а остальные поля контента передаются по одному разу.
func Replacement(snapshot Snapshot, revision int64, content transfer.Document) (Patch, error) {
	current, err := transfer.Routes(snapshot.Routes, false)
	if err != nil {
		return Patch{}, err
	}
	ids := make(map[string]bool)
	for _, route := range content.Routes {
		ids[route.ID] = true
	}
	operations := make([]Operation, 0, len(current)+len(content.Routes)+3)
	for _, route := range current {
		if !ids[route.ID] {
			operations = append(operations, Operation{Kind: "removeRoute", RouteID: &route.ID})
		}
	}
	for _, route := range content.Routes {
		operations = append(operations, Operation{
			Kind:    "putRoute",
			RouteID: &route.ID,
			Route:   route.Route,
			Prompts: route.Prompts,
		})
	}
	operations = append(operations,
		Operation{Kind: "putBootstrap", Bootstrap: content.Bootstrap, Prompts: content.BootstrapPrompts},
		Operation{Kind: "putPresentation", Presentation: content.Presentation},
		Operation{Kind: "putProvenance", Provenance: content.Provenance},
	)
	return Patch{ExpectedRevision: revision, Operations: operations}, nil
}
