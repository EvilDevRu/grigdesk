package state

import (
	"crypto/sha256"
	"testing"
)

func TestPendingAtBase(t *testing.T) {
	oldTree := sha256.Sum256([]byte("source-v1\n"))
	newTree := sha256.Sum256([]byte("source-v2\n"))
	base := pendingCursor{sequence: 2, head: sha256.Sum256([]byte("event\n")), node: "build"}
	ready := base
	ready.state = "ready"
	cases := []struct {
		name    string
		mutate  func(*pendingCursor)
		tree    *[32]byte
		atBase  bool
		result  string
		invalid bool
	}{
		{"snapshot-needed", nil, nil, true, "needs-tree", false},
		{"same-tree", nil, &oldTree, true, "ready", false},
		{"changed-tree", nil, &newTree, true, "stale", false},
		{"wrong-node", func(c *pendingCursor) { c.node = "review" }, &oldTree, false, "", true},
		{"wrong-state", func(c *pendingCursor) { c.state = "stopped" }, &oldTree, false, "", true},
		{"older", func(c *pendingCursor) { c.sequence-- }, nil, false, "", true},
		{"advanced", func(c *pendingCursor) { c.sequence++ }, nil, false, "", false},
		{"other-head", func(c *pendingCursor) { c.head[0] ^= 1 }, nil, false, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			current := ready
			if tc.mutate != nil {
				tc.mutate(&current)
			}
			match, result, err := classifyPendingAtBase(base, current, oldTree, tc.tree)
			if match != tc.atBase || result != tc.result || (err != nil) != tc.invalid {
				t.Fatalf("match=%t result=%q err=%v", match, result, err)
			}
		})
	}
}
