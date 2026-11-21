package managed

import (
	"bytes"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"grigdesk.local/tools/utilities/relay/internal/protocol"
	"grigdesk.local/tools/utilities/relay/internal/tunnel"
)

func TestManagedGateChecksEffectiveSettingsAndProof(t *testing.T) {
	const id = "r0123456789abcdef"
	const job = "87fa75b5-42f1-4510-aac5-24c356290a70"
	parent := filepath.Join(t.TempDir(), id)
	if err := os.Mkdir(parent, 0o755); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(parent, "grigdesk-relay")
	executable := []byte("isolated binary snapshot")
	if err := os.WriteFile(binary, executable, 0o755); err != nil {
		t.Fatal(err)
	}
	actual, err := os.Stat(binary)
	if err != nil {
		t.Fatal(err)
	}
	config := tunnel.Config{
		Certificate: tls.Certificate{Certificate: [][]byte{[]byte("isolated cert bytes")}},
		Port:        7443,
	}
	artifact := sha256.Sum256(executable)
	certificate := sha256.Sum256(config.Certificate.Certificate[0])
	allowed := gate{
		Schema: 1, Status: "approved", Generation: job, TargetSHA: hex.EncodeToString(artifact[:]),
		JobID: job, Host: tunnel.BindHost, Port: config.Port, Certificate: hex.EncodeToString(certificate[:]),
		RelayID: id,
	}
	secret := bytes.Repeat([]byte{3}, 32)
	pinned := claim{
		Schema: 1, JobID: job, RelayID: id, ReleaseID: "release/0.2.0/abcdef",
		ArtifactSHA: hex.EncodeToString(artifact[:]), Secret: base64.RawURLEncoding.EncodeToString(secret),
	}
	writeFixture(t, filepath.Join(parent, "proof.json"), pinned, 0o640)
	gatePath := filepath.Join(parent, "gate.json")
	load := func(effective tunnel.Config) (tunnel.HealthProof, error) {
		return read(parent, binary, actual, effective, uint32(os.Getuid()))
	}

	allowed.Status = "blocked"
	writeFixture(t, gatePath, allowed, 0o644)
	if _, err := load(config); err == nil {
		t.Fatal("Допуск blocked открыл запуск")
	}

	allowed.Status = "approved"
	writeFixture(t, gatePath, allowed, 0o644)
	stale := config
	stale.Port = 8222
	if _, err := load(stale); err == nil {
		t.Fatal("Устаревший EnvironmentFile прошёл допуск")
	}

	reply, err := load(config)
	if err != nil {
		t.Fatal(err)
	}
	challenge := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32))
	body := "grigdesk relay check v1\n" + challenge
	request := func(mac []byte) protocol.Hello {
		proof, err := json.Marshal(map[string]any{
			"schema": 1, "challenge": challenge, "mac": base64.RawURLEncoding.EncodeToString(mac),
		})
		if err != nil {
			t.Fatal(err)
		}
		return protocol.Hello{Proof: proof}
	}

	if rejected := reply(request(sign(bytes.Repeat([]byte{1}, 32), body))); rejected.OK || rejected.Proof != nil {
		t.Fatal("Неверный HMAC раскрыл поколение")
	}
	accepted := reply(request(sign(secret, body)))
	var response struct {
		Challenge string `json:"challenge"`
		MAC       string `json:"mac"`
	}
	if !accepted.OK || json.Unmarshal(accepted.Proof, &response) != nil || response.Challenge != challenge {
		t.Fatal("Подтверждение поколения отсутствует")
	}
	witness := "grigdesk relay proof v1\n" + challenge + "\n" + id + "\n" +
		pinned.ReleaseID + "\n" + pinned.ArtifactSHA
	if response.MAC != base64.RawURLEncoding.EncodeToString(sign(secret, witness)) {
		t.Fatal("Ответ подписан за пределами домена доказательства")
	}

	if err := os.WriteFile(binary, []byte("changed bytes"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := load(config); err == nil {
		t.Fatal("Подменённый бинарник прошёл допуск")
	}
}

func writeFixture(t *testing.T, file string, value any, mode os.FileMode) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, data, mode); err != nil {
		t.Fatal(err)
	}
}
