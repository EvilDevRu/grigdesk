package managed

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"syscall"

	"grigdesk.local/tools/utilities/relay/internal/protocol"
	"grigdesk.local/tools/utilities/relay/internal/tunnel"
)

const managedRoot = "/opt/grigdesk-relay"

var (
	relayID = regexp.MustCompile(`^r[0-9a-f]{8,32}$`)
	jobID   = regexp.MustCompile(`^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$`)
	digest  = regexp.MustCompile(`^[0-9a-f]{64}$`)
	release = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$`)
)

type gate struct {
	Schema      int    `json:"schema"`
	Status      string `json:"status"`
	Generation  string `json:"generation"`
	TargetSHA   string `json:"targetSha"`
	JobID       string `json:"jobId"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	Certificate string `json:"certFingerprint"`
	RelayID     string `json:"relayId"`
}

type claim struct {
	Schema      int    `json:"schema"`
	JobID       string `json:"jobId"`
	RelayID     string `json:"relayId"`
	ReleaseID   string `json:"releaseId"`
	ArtifactSHA string `json:"artifactSha"`
	Secret      string `json:"secret"`
}

// Read применяет правило допуска к физическому пути ELF в каталоге мастера.
// Отдельно установленный файл работает по прежнему wire-контракту.
func Read(config tunnel.Config) (tunnel.HealthProof, error) {
	if runtime.GOOS != "linux" {
		return nil, nil
	}
	executable, err := os.Readlink("/proc/self/exe")
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(executable, managedRoot+"/") {
		return nil, nil
	}
	if filepath.Base(executable) != "grigdesk-relay" {
		return nil, errors.New("Неканонический путь relay")
	}
	parent := filepath.Dir(executable)
	if filepath.Dir(parent) != managedRoot || !relayID.MatchString(filepath.Base(parent)) {
		return nil, errors.New("Неканонический каталог relay")
	}
	actual, err := os.Stat("/proc/self/exe")
	if err != nil {
		return nil, err
	}
	return read(parent, executable, actual, config, 0)
}

func read(parent, executable string, actual os.FileInfo, config tunnel.Config, owner uint32) (tunnel.HealthProof, error) {
	info, err := os.Lstat(parent)
	if err != nil || !info.IsDir() || !hasOwner(info, owner) || info.Mode().Perm() != 0o755 {
		return nil, errors.New("Каталог relay закрыт")
	}
	var allowed gate
	if err := readJSON(filepath.Join(parent, "gate.json"), owner, 0o644, &allowed); err != nil {
		return nil, err
	}
	certSHA := sha256.Sum256(config.Certificate.Certificate[0])
	if allowed.Schema != 1 || allowed.Status != "approved" || !jobID.MatchString(allowed.JobID) ||
		allowed.Generation != allowed.JobID || allowed.RelayID != filepath.Base(parent) ||
		allowed.Host != tunnel.BindHost || allowed.Port != config.Port ||
		allowed.Certificate != hex.EncodeToString(certSHA[:]) || !digest.MatchString(allowed.TargetSHA) {
		return nil, errors.New("Настройки расходятся с допуском relay")
	}
	if err := verifyExecutable(executable, actual, allowed.TargetSHA, owner); err != nil {
		return nil, err
	}
	var proof claim
	if err := readJSON(filepath.Join(parent, "proof.json"), owner, 0o640, &proof); err != nil {
		return nil, err
	}
	secret, ok := proofValue(proof.Secret)
	if proof.Schema != 1 || proof.JobID != allowed.JobID || proof.RelayID != allowed.RelayID ||
		!release.MatchString(proof.ReleaseID) || !digest.MatchString(proof.ArtifactSHA) || !ok {
		return nil, errors.New("Доказательство установки relay повреждено")
	}
	return proof.reply(secret), nil
}

func hasOwner(info os.FileInfo, owner uint32) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == owner
}

func verifyExecutable(name string, actual os.FileInfo, expected string, owner uint32) error {
	file, err := os.Open(name)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o755 ||
		!hasOwner(info, owner) || !os.SameFile(info, actual) {
		return errors.New("Файл relay отличается от проверенного")
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return err
	}
	if hex.EncodeToString(hash.Sum(nil)) != expected {
		return errors.New("Хеш relay отличается от проверенного")
	}
	return nil
}

func readJSON(name string, owner uint32, mode os.FileMode, target any) error {
	info, err := os.Lstat(name)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != mode ||
		!hasOwner(info, owner) || info.Size() > 2048 {
		return errors.New("Файл допуска relay недоступен")
	}
	data, err := os.ReadFile(name)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

func proofValue(value string) ([]byte, bool) {
	if len(value) != 43 {
		return nil, false
	}
	bytes, err := base64.RawURLEncoding.Strict().DecodeString(value)
	return bytes, err == nil && len(bytes) == sha256.Size
}

func (proof claim) reply(secret []byte) tunnel.HealthProof {
	return func(hello protocol.Hello) protocol.Reply {
		var request struct {
			Schema    int    `json:"schema"`
			Challenge string `json:"challenge"`
			MAC       string `json:"mac"`
		}
		bad := protocol.Reply{Error: "bad_deployment_proof"}
		if json.Unmarshal(hello.Proof, &request) != nil || request.Schema != 1 {
			return bad
		}
		_, validChallenge := proofValue(request.Challenge)
		mac, validMAC := proofValue(request.MAC)
		if !validChallenge || !validMAC ||
			!hmac.Equal(mac, sign(secret, "grigdesk relay check v1\n"+request.Challenge)) {
			return bad
		}
		answer := strings.Join([]string{"grigdesk relay proof v1", request.Challenge,
			proof.RelayID, proof.ReleaseID, proof.ArtifactSHA}, "\n")
		data, err := json.Marshal(struct {
			Schema      int    `json:"schema"`
			Challenge   string `json:"challenge"`
			RelayID     string `json:"relayId"`
			ReleaseID   string `json:"releaseId"`
			ArtifactSHA string `json:"artifactSha"`
			MAC         string `json:"mac"`
		}{1, request.Challenge, proof.RelayID, proof.ReleaseID, proof.ArtifactSHA,
			base64.RawURLEncoding.EncodeToString(sign(secret, answer))})
		if err != nil {
			return bad
		}
		return protocol.Reply{OK: true, Proof: data}
	}
}

func sign(secret []byte, body string) []byte {
	mac := hmac.New(sha256.New, secret)
	_, _ = io.WriteString(mac, body)
	return mac.Sum(nil)
}
