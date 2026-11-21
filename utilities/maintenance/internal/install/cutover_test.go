package install

import "testing"

func TestObservedCutoverFollowsDurableFiles(t *testing.T) {
	for _, fixture := range []struct {
		helper  string
		pointer string
		want    string
	}{
		{"old-helper", "old-pointer", "prepared"},
		{"new-helper", "old-pointer", "helper_active"},
		{"new-helper", "new-pointer", "generation_active"},
		{"old-helper", "new-pointer", ""},
		{"foreign", "new-pointer", ""},
		{"new-helper", "foreign", ""},
	} {
		phase, err := observed("old-helper", "new-helper", "old-pointer", "new-pointer", fixture.helper, fixture.pointer)
		if phase != fixture.want || (err != nil) != (fixture.want == "") {
			t.Fatalf("несогласованное состояние %q, %q: %q, %v", fixture.helper, fixture.pointer, phase, err)
		}
	}
}
