package voicecore

import (
	"reflect"
	"testing"
)

// TestNarration сохраняет значимые плюсы и отличает их от обычного текста.
// Координаты проверяются после схлопывания пробелов.
func TestNarration(t *testing.T) {
	value := ParseText("  з+амок\n  +Арсенал и 2+2, C++ ")
	if string(value.Text) != "замок Арсенал и 2+2, C++" || !reflect.DeepEqual(value.Stress, []int{1, 6}) {
		t.Fatalf("получен текст %q, ударения %v", string(value.Text), value.Stress)
	}
	input := Input{Pace: "slow", Instruction: "тихо"}
	want := []string{"темп", "ударения", "инструкция"}
	if got := Ignored(input, value, Capabilities{}); !reflect.DeepEqual(got, want) {
		t.Fatalf("получены указания %v", got)
	}
}
