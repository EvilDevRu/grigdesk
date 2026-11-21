package engine_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// reserveRuntime использует реальную серверную выдачу pin в изолированных корнях.
// Go start вызывает проверяющую обёртку перед настоящим серверным bind helper.
func (f *routeFixture) reserveRuntime(t *testing.T) {
	t.Helper()
	js := `
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [repo, data, binary, controlRoot, stateRoot, profileRoot] = process.argv.slice(1);
const { reserveFactoryRuntime } = await import(pathToFileURL(repo + '/server/src/lib/factoryRuntimePins.ts'));
const cacheDir = path.join(data, 'cache');
const packageId = 'a'.repeat(64);
const runtimeRoot = path.join(cacheDir, 'packages', packageId);
const engineHome = path.join(runtimeRoot, 'engine');
const engineBin = path.join(engineHome, 'bin/factory');
const node = path.join(runtimeRoot, 'runtime/node/bin/node');
for (const dir of [path.dirname(engineBin), path.dirname(node), controlRoot]) {
  await fs.mkdir(dir, {recursive:true, mode:0o700});
}
await fs.copyFile(binary, engineBin);
await fs.chmod(engineBin, 0o555);
await fs.writeFile(node, "#!/bin/sh\nexec '" + process.execPath + "' \"$@\"\n", {mode:0o555});
const hold = await reserveFactoryRuntime({
  cacheDir, packageId, runtimeRoot, engineHome, engineBin, node, controlRoot, stateRoot, profileRoot,
  task:'7101',
});
console.log(JSON.stringify({node,...hold}));
`
	args := []string{"--input-type=module", "-e", js, f.repo, f.dir, f.binary,
		f.store.ControlDir, f.store.StateDir, filepath.Dir(f.profile)}
	raw := f.runFixture(t, "node", args...)
	var reservation struct {
		Node, Reservation, Scope string
	}
	if err := json.Unmarshal([]byte(raw), &reservation); err != nil || reservation.Reservation == "" {
		t.Fatalf("нет runtime reservation: %s %v", raw, err)
	}
	wrapper := filepath.Join(f.dir, "observe-bind.mjs")
	f.write(t, wrapper, `
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const argv = process.argv.slice(2);
const args = Object.fromEntries(argv.slice(1).flatMap((word,index,array) =>
  index % 2 === 0 ? [[word,array[index+1]]] : []));
const attemptDir = args['--attempt-dir'];
const active = path.resolve(attemptDir, '../../active-attempt.json');
if (argv[0] !== 'bind' || !fs.statSync(attemptDir).isDirectory() || fs.existsSync(active)) {
  process.exit(78);
}
execFileSync(process.execPath, [process.env.HELPER_FOR_TEST, ...argv], {stdio:'inherit'});
if (fs.existsSync(active)) {
  process.exit(78);
}
fs.writeFileSync(path.join(process.env.FIXTURE_ROOT,'bind.observed'), args['--attempt'] + '\n');
`)
	f.runtimeEnv = []string{
		"GRIGDESK_SERVER_RUNTIME_RESERVATION=" + reservation.Reservation,
		"GRIGDESK_SERVER_RUNTIME_NODE=" + reservation.Node,
		"GRIGDESK_SERVER_RUNTIME_PIN_HELPER=" + wrapper,
		"HELPER_FOR_TEST=" + filepath.Join(f.repo, "server", "scripts", "factoryRuntimePin.mts"),
		"BOUND_SCOPE_FOR_TEST=" + reservation.Scope,
	}
}

func (f routeFixture) assertBound(t *testing.T, id string) {
	t.Helper()
	f.readEqual(t, filepath.Join(f.dir, "bind.observed"), id+"\n")
	scope := ""
	for _, entry := range f.runtimeEnv {
		if value, ok := strings.CutPrefix(entry, "BOUND_SCOPE_FOR_TEST="); ok {
			scope = value
		}
	}
	pin := filepath.Join(f.store.ControlDir, "server-runtimes", scope, id+".json")
	raw, err := os.ReadFile(pin)
	if err != nil || !json.Valid(raw) || !strings.Contains(string(raw), id) {
		t.Fatalf("runtime pin не принят: %v", err)
	}
	t.Logf("final → bind → active, attempt=%s", id)
}
