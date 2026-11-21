package grigdeskapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestRequestStopsAtRedirect проверяет исходный HTTP статус и отсутствие второго запроса.
// Тело и заголовки обрабатываются позже, после выбора политики конкретного клиента.
func TestRequestStopsAtRedirect(t *testing.T) {
	second := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("клиент прошёл по redirect")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer second.Close()

	first := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", second.URL)
		w.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer first.Close()

	response, err := Request(context.Background(), http.MethodPost, first.URL, nil, Policy{})
	if err != nil || response.Status != http.StatusTemporaryRedirect {
		t.Fatalf("status=%d err=%v", response.Status, err)
	}
}
