package publication

import (
	"crypto/rand"
	"fmt"
)

type Payload struct {
	ExpectedRevision       int64   `json:"expectedRevision"`
	ExpectedCatalogHash    *string `json:"expectedCatalogHash"`
	ExpectedSourceRevision int64   `json:"expectedSourceRevision"`
	OperationID            string  `json:"operationId"`
}

type Hint struct {
	OperationID string   `json:"operationId"`
	DraftID     string   `json:"draftId"`
	Recovery    []string `json:"recovery"`
}

// Prepare закрепляет ID и ожидания до первой записи в каталог.
// Ветвь rollback после создания копии уточняет только ревизию нового черновика.
func Prepare(revision, source int64, catalog *string) Payload {
	var id [16]byte
	_, _ = rand.Read(id[:])
	id[6] = id[6]&0x0f | 0x40
	id[8] = id[8]&0x3f | 0x80
	operation := fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:])
	return Payload{
		ExpectedRevision:       revision,
		ExpectedCatalogHash:    catalog,
		ExpectedSourceRevision: source,
		OperationID:            operation,
	}
}

// RecoveryHint использует тот же идентификатор, который сервер получит в POST.
// Команда чтения квитанции передаётся массивом аргументов без shell-интерпретации.
func (payload Payload) RecoveryHint(profile, draftID string) Hint {
	return Hint{
		OperationID: payload.OperationID,
		DraftID:     draftID,
		Recovery:    []string{"publications", profile, payload.OperationID},
	}
}
