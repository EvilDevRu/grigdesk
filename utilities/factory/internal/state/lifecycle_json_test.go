package state

import (
	"slices"
	"testing"
)

func TestLifecycleStringFormat(t *testing.T) {
	want := `"<>&\u0001\t\"\\"`
	value := "<>&\x01\t\"\\"
	if got := lifecycleString(value); got != want {
		t.Fatalf("байты строки %q, ожидались %q", got, want)
	}
	if got := lifecycleString("\u2028\u2029"); got != "\"\u2028\u2029\"" {
		t.Fatalf("разделители Юникода перекодированы: %x", got)
	}
	keys := []string{"\ue000", "Я", "a", "\U00010000"}
	slices.SortFunc(keys, lifecycleKeyOrder)
	if !slices.Equal(keys, []string{"a", "Я", "\U00010000", "\ue000"}) {
		t.Fatalf("порядок ключей: %q", keys)
	}
}
