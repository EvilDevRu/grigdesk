package route

import (
	"encoding/json"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestContextDeliveryStrategies(t *testing.T) {
	cases := map[string][]string{
		"commit": {"commit"}, "merge": {"commit", "merge"},
		"pull-request": {"commit", "push", "pull-request"},
	}
	for strategy, actions := range cases {
		t.Run(strategy, func(t *testing.T) {
			options := contextOptions{
				"delivery-strategy": {strategy}, "delivery-action": actions, "delivery-mode": {"publish"},
				"delivery-target": {"app=main"}, "source-branch": {"task-42"},
			}
			delivery, err := options.delivery([]string{"app"})
			if err != nil {
				t.Fatal(err)
			}
			if delivery["strategy"] != strategy || !slices.Equal(delivery["actions"].([]string), actions) {
				t.Fatalf("искажён контракт сдачи: %v", delivery)
			}

			options["delivery-action"] = append(slices.Clone(actions), "task-comment")
			if _, err := options.delivery([]string{"app"}); err == nil {
				t.Fatal("явная стратегия приняла лишнее право на комментарий")
			}
		})
	}
}

func TestBootstrapFindingFreshness(t *testing.T) {
	raw := `{
  "schema": 2,
  "open": [{
    "id":"valid-regex-route","sourceNode":"scout","owner":"build",
    "summary":"валидный regex возвращает 422","openedSequence":4,
    "lastSeenSequence":6,"status":"open","closedSequence":null,"source":{"phase":"route"}
  }],
  "closed": [],
  "deferred": [{
    "id":"valid-regex-route","sourceNode":"scout","owner":"build","summary":"Проверка целевой среды",
    "openedSequence":null,"lastSeenSequence":null,"closedSequence":null,"status":"deferred",
    "source":{
      "phase":"bootstrap","recordHash":"` + strings.Repeat("a", 64) + `","runId":"fixture-scout","epoch":1
    }
  }]
}`
	findings, err := parseFindings(raw, maxContextFile, 2000)
	if err != nil {
		t.Fatal(err)
	}

	bounded := boundLoopFindings(findings)
	deferred := arrayValue(bounded["deferred"])
	if bounded["schema"] != json.Number("2") || len(deferred) != 1 {
		t.Fatalf("неверная схема или deferred: %v", bounded)
	}
	record := objectValue(deferred[0])
	if objectValue(record["source"])["phase"] != "bootstrap" || record["openedSequence"] != nil {
		t.Fatalf("искажена проекция bootstrap: %v", record)
	}
	if freshness := findingFreshness("deferred", record); freshness != [3]int{0, 0, 0} {
		t.Fatalf("ключ свежести для bootstrap: %v", freshness)
	}
}

func TestHistoricalMachineRetainsProductFailureRewind(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "routes")
	pins := publishFixture(t, dir)
	reader, err := NewBundleReader(dir, "demo-profile")
	if err != nil {
		t.Fatal(err)
	}
	bundle, err := reader.ReadRoute("debug", pins.RouteHash)
	if err != nil {
		t.Fatal(err)
	}
	check := findNode(bundle.Machine, "check")
	check["executor"] = "agent"
	delete(check, "commandId")
	check["prompt"] = object{
		"blocks": []any{object{"file": "prompts/check.base.md"}}, "requiredContext": []any{"task"},
	}
	bundle.Prompts["prompts/check.base.md"] = "Проверь результат."
	objectValue(check["retry"])["productFailure"] = json.Number("1")
	objectValue(check["on"])["failed"] = object{"rewind": "instrument", "reset": []any{"instrument", "check"}}

	if _, err := validateMachine(bundle, "demo-profile", "debug", "route", true); err != nil {
		t.Fatalf("историческая машина должна читаться: %v", err)
	}
	if _, err := validateMachine(bundle, "demo-profile", "debug", "route", false); err == nil ||
		!strings.Contains(err.Error(), "retry.productFailure") {
		t.Fatalf("новый черновик должен отклонить двойной повтор: %v", err)
	}
}
