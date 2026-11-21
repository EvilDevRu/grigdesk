package installation

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/url"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

var releaseKeyBase64 = "MCowBQYDK2VwAyEA/YGUiVW8isVOUt6dI68DgQ2qBAbgI9Oxz5TqoR5D3aw="
var releaseDistributionSource = "channel"

type File struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	Mode   uint32 `json:"mode"`
}

type Artifact struct {
	PackageID   string `json:"packageId"`
	URL         string `json:"url"`
	Size        int64  `json:"size"`
	SHA256      string `json:"sha256"`
	Unpacked    int64  `json:"unpackedSize"`
	Files       []File `json:"files"`
	FilesDigest string `json:"filesDigest"`
}

type Platform struct {
	OS       string `json:"os"`
	Arch     string `json:"arch"`
	Glibc    string `json:"glibc"`
	MinMacOS string `json:"minMacOS"`
}

type APIRange struct {
	Major    uint64 `json:"major"`
	Minor    uint64 `json:"minor"`
	MinMinor uint64 `json:"minMinor"`
}

type Manifest struct {
	ServerAPI       APIRange            `json:"serverApi"`
	DesktopRequires APIRange            `json:"desktopRequiresServerApi"`
	Format          int                 `json:"-"`
	PublishedAt     string              `json:"publishedAt"`
	Channel         string              `json:"channel"`
	Version         string              `json:"version"`
	Commit          string              `json:"commit"`
	ReleaseID       string              `json:"releaseId"`
	Platform        Platform            `json:"platform"`
	Artifacts       map[string]Artifact `json:"artifacts"`
	Digest          string              `json:"-"`
}

func releaseKey() (ed25519.PublicKey, string, error) {
	der, err := base64.StdEncoding.Strict().DecodeString(releaseKeyBase64)
	if err != nil {
		return nil, "", err
	}
	decoded, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, "", err
	}
	key, ok := decoded.(ed25519.PublicKey)
	if !ok {
		return nil, "", errors.New("release_signing_key_invalid")
	}
	normalized := strings.TrimSuffix(string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})), "\n")
	return key, Hash([]byte(normalized + "\n")), nil
}

func (layout *Layout) releaseTrust() (ed25519.PublicKey, error) {
	key, fingerprint, err := releaseKey()
	if err != nil {
		return nil, err
	}
	receipt := layout.Receipt
	if releaseDistributionSource == "channel" && receipt.Format != 1 ||
		releaseDistributionSource != "channel" && (receipt.Format != 2 ||
			receipt.Source != releaseDistributionSource || receipt.TrustKeySHA256 != fingerprint) {
		return nil, errors.New("installation_release_trust_mismatch")
	}
	return key, nil
}

// VerifyManifest проверяет подпись исходной канонической описи и отдельную опись файлов.
func VerifyManifest(data []byte, key ed25519.PublicKey) (Manifest, error) {
	var wire struct {
		Format    int             `json:"format"`
		Payload   json.RawMessage `json:"payload"`
		Signature string          `json:"signature"`
	}
	if _, err := CanonicalJSON(data); err != nil || json.Unmarshal(data, &wire) != nil {
		return Manifest{}, errors.New("release_manifest_invalid")
	}
	format := 2
	if wire.Format == 3 && exactFields(data, "format", "payload", "signature") {
		format = 3
	} else if !exactFields(data, "payload", "signature") {
		return Manifest{}, errors.New("release_manifest_invalid")
	}
	payload, err := CanonicalJSON(wire.Payload)
	if err != nil {
		return Manifest{}, err
	}
	signed := append(fmt.Appendf(nil, "GrigDesk release v%d\n", format), payload...)
	signed = append(signed, '\n')
	signature, err := base64.StdEncoding.Strict().DecodeString(wire.Signature)
	if err != nil || len(key) != ed25519.PublicKeySize || !ed25519.Verify(key, signed, signature) {
		return Manifest{}, errors.New("release_signature_invalid")
	}
	var parsed Manifest
	if json.Unmarshal(wire.Payload, &parsed) != nil || !ValidVersion(parsed.Version) ||
		(parsed.Channel != "release" && parsed.Channel != "dev") ||
		parsed.ReleaseID != parsed.Channel+"/"+parsed.Version+"/"+parsed.Commit ||
		len(parsed.Artifacts) != format ||
		!commitPattern.MatchString(parsed.Commit) || !validPublishedAt(parsed.PublishedAt) ||
		(parsed.Channel == "dev") != strings.Contains(parsed.Version, "-dev.") ||
		!exactFields(wire.Payload, "channel", "version", "commit", "releaseId", "publishedAt", "notes",
			"dataCompatibility", "serverApi", "desktopRequiresServerApi", "platform", "artifacts") ||
		!validPublishedFields(wire.Payload, parsed.Platform) {
		return Manifest{}, errors.New("release_manifest_invalid")
	}
	var listings struct {
		Artifacts map[string]json.RawMessage `json:"artifacts"`
	}
	if json.Unmarshal(wire.Payload, &listings) != nil {
		return Manifest{}, errors.New("release_manifest_invalid")
	}
	components := []string{"desktop", "server"}
	if format == 3 {
		components = append(components, "control")
	}
	for _, component := range components {
		artifact, ok := parsed.Artifacts[component]
		raw, okIndex := listings.Artifacts[component]
		if !ok || !okIndex || !validInventory(artifact) || !validArtifactFields(raw, parsed, component) {
			return Manifest{}, errors.New("release_files_invalid")
		}
		if component == "control" && (len(artifact.Files) != 1 ||
			artifact.Files[0].Path != "bin/grigdesk-ctl" || artifact.Files[0].Mode != 0o555) {
			return Manifest{}, errors.New("release_control_inventory_invalid")
		}
		var rawArtifact struct {
			Files json.RawMessage `json:"files"`
		}
		_ = json.Unmarshal(raw, &rawArtifact)
		canonical, err := CanonicalJSON(rawArtifact.Files)
		if err != nil || Hash(canonical) != artifact.FilesDigest {
			return Manifest{}, errors.New("release_files_digest_invalid")
		}
	}
	parsed.Format = format
	parsed.Digest = Hash(signed)
	return parsed, nil
}

func validInventory(artifact Artifact) bool {
	endpoint, err := url.Parse(artifact.URL)
	if err != nil || endpoint.Scheme != "https" || endpoint.Host == "" || endpoint.User != nil ||
		endpoint.Fragment != "" || len(artifact.Files) == 0 || len(artifact.Files) > 10_000 ||
		artifact.Size <= 0 || artifact.Size > 1<<53-1 || !sha256Text.MatchString(artifact.SHA256) {
		return false
	}
	paths := make(map[string]bool)
	var unpacked int64
	for _, item := range artifact.Files {
		if !validRelative(item.Path) || !archiveName.MatchString(item.Path) || paths[item.Path] ||
			!sha256Text.MatchString(item.SHA256) || item.Size < 0 || item.Size > (1<<53-1)-unpacked ||
			item.Mode != 0o444 && item.Mode != 0o555 && item.Mode != 0o644 && item.Mode != 0o755 {
			return false
		}
		unpacked += item.Size
		paths[item.Path] = true
	}
	for path := range paths {
		for index := strings.IndexByte(path, '/'); index >= 0; {
			if paths[path[:index]] {
				return false
			}
			offset := strings.IndexByte(path[index+1:], '/')
			if offset < 0 {
				break
			}
			index += offset + 1
		}
	}
	return unpacked > 0 && unpacked == artifact.Unpacked
}

func (layout *Layout) Manifest(componentPath, component string) (Manifest, error) {
	key, err := layout.releaseTrust()
	if err != nil {
		return Manifest{}, err
	}
	parts := strings.Split(componentPath, "/")
	if len(parts) < 2 || parts[0] != "generations" || !ValidVersion(parts[1]) ||
		component == "control" && len(parts) != 2 ||
		component != "control" && (len(parts) != 3 || parts[2] != component) {
		return Manifest{}, errors.New("release_generation_identity_invalid")
	}
	content, err := layout.ReadPrivate("generations/" + parts[1] + "/release.json")
	if err != nil {
		return Manifest{}, err
	}
	manifest, err := VerifyManifest(content, key)
	if err != nil {
		return Manifest{}, err
	}
	arch := map[string]string{"amd64": "x64", "arm64": "arm64"}[runtime.GOARCH]
	if manifest.Version != parts[1] || manifest.Platform.OS != runtime.GOOS ||
		manifest.Platform.Arch != arch || component == "control" && manifest.Format != 3 {
		return Manifest{}, errors.New("release_generation_identity_invalid")
	}
	return manifest, nil
}

func Hash(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

// CanonicalJSON повторяет порядок UTF-16 и формат подписанного JSON.
func CanonicalJSON(data []byte) ([]byte, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	value, err := uniqueJSON(decoder, 0)
	if err != nil {
		return nil, err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return nil, errors.New("release_json_invalid")
	}
	return canonicalValue(nil, value)
}

func canonicalValue(buffer []byte, value any) ([]byte, error) {
	switch item := value.(type) {
	case nil:
		return append(buffer, "null"...), nil
	case bool:
		return strconv.AppendBool(buffer, item), nil
	case string:
		return writeJSONString(buffer, item), nil
	case json.Number:
		number, err := strconv.ParseFloat(string(item), 64)
		if err != nil {
			return nil, errors.New("release_number_invalid")
		}
		encoded, err := json.Marshal(number)
		if err != nil {
			return nil, err
		}
		if number == 0 {
			encoded = []byte("0")
		}
		return append(buffer, encoded...), nil
	case []any:
		buffer = append(buffer, '[')
		for index, value := range item {
			if index != 0 {
				buffer = append(buffer, ',')
			}
			var err error
			buffer, err = canonicalValue(buffer, value)
			if err != nil {
				return nil, err
			}
		}
		return append(buffer, ']'), nil
	case map[string]any:
		keys := make([]string, 0, len(item))
		for key := range item {
			keys = append(keys, key)
		}
		sort.Slice(keys, func(a, b int) bool { return utf16Less(keys[a], keys[b]) })
		buffer = append(buffer, '{')
		for index, key := range keys {
			if index != 0 {
				buffer = append(buffer, ',')
			}
			buffer = writeJSONString(buffer, key)
			var err error
			buffer, err = canonicalValue(append(buffer, ':'), item[key])
			if err != nil {
				return nil, err
			}
		}
		return append(buffer, '}'), nil
	default:
		return nil, errors.New("release_json_invalid")
	}
}

func utf16Less(a, b string) bool {
	a16, b16 := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for index := 0; index < min(len(a16), len(b16)); index++ {
		if a16[index] != b16[index] {
			return a16[index] < b16[index]
		}
	}
	return len(a16) < len(b16)
}

func writeJSONString(buffer []byte, item string) []byte {
	buffer = append(buffer, '"')
	for _, symbol := range item {
		switch symbol {
		case '"', '\\':
			buffer = append(buffer, '\\', byte(symbol))
		case '\b':
			buffer = append(buffer, `\b`...)
		case '\f':
			buffer = append(buffer, `\f`...)
		case '\n':
			buffer = append(buffer, `\n`...)
		case '\r':
			buffer = append(buffer, `\r`...)
		case '\t':
			buffer = append(buffer, `\t`...)
		default:
			if symbol < 32 {
				buffer = fmt.Appendf(buffer, "\\u%04x", symbol)
			} else {
				buffer = append(buffer, string(symbol)...)
			}
		}
	}
	return append(buffer, '"')
}

var commitPattern = regexp.MustCompile(`^[0-9a-f]{40,64}$`)
var archiveName = regexp.MustCompile(`^[A-Za-z0-9_./-]+$`)
var glibcVersion = regexp.MustCompile(`^[0-9]+\.[0-9]+$`)

func validPublishedAt(value string) bool {
	const format = "2006-01-02T15:04:05.000Z"
	parsed, err := time.Parse(format, value)
	return err == nil && parsed.Format(format) == value
}

func validPublishedFields(value []byte, platform Platform) bool {
	var fields struct {
		Notes      json.RawMessage `json:"notes"`
		Data       string          `json:"dataCompatibility"`
		ServerAPI  json.RawMessage `json:"serverApi"`
		DesktopAPI json.RawMessage `json:"desktopRequiresServerApi"`
		Platform   json.RawMessage `json:"platform"`
	}
	if json.Unmarshal(value, &fields) != nil || fields.Data != "unchanged-v1" ||
		!validAPI(fields.ServerAPI, "minor") || !validAPI(fields.DesktopAPI, "minMinor") {
		return false
	}
	switch platform.OS {
	case "linux":
		if !exactFields(fields.Platform, "os", "arch", "glibc") || platform.Arch != "x64" ||
			!glibcVersion.MatchString(platform.Glibc) {
			return false
		}
	case "darwin":
		if !exactFields(fields.Platform, "os", "arch", "minMacOS") ||
			platform.Arch != "arm64" || platform.MinMacOS != "15.0" {
			return false
		}
	default:
		return false
	}
	if string(fields.Notes) == "null" {
		return true
	}
	var notes map[string]*string
	return exactFields(fields.Notes, "ru", "en") && json.Unmarshal(fields.Notes, &notes) == nil &&
		notes["ru"] != nil && notes["en"] != nil && len(utf16.Encode([]rune(*notes["ru"]))) <= 16000 &&
		len(utf16.Encode([]rune(*notes["en"]))) <= 16000
}

func validAPI(value []byte, minor string) bool {
	var parsed map[string]*uint64
	return exactFields(value, "major", minor) && json.Unmarshal(value, &parsed) == nil &&
		parsed["major"] != nil && *parsed["major"] <= 1<<53-1 &&
		parsed[minor] != nil && *parsed[minor] <= 1<<53-1
}

func validArtifactFields(value []byte, manifest Manifest, component string) bool {
	keys := []string{"url", "size", "sha256", "unpackedSize", "files", "filesDigest", "buildIdentity"}
	if component == "server" {
		keys = append(keys, "packageId")
	} else if component == "desktop" && manifest.Platform.OS == "darwin" {
		keys = append(keys, "unpackedBundleBytes")
	}
	if !exactFields(value, keys...) {
		return false
	}
	var raw struct {
		Files               []json.RawMessage `json:"files"`
		Build               json.RawMessage   `json:"buildIdentity"`
		PackageID           string            `json:"packageId"`
		UnpackedBundleBytes uint64            `json:"unpackedBundleBytes"`
	}
	if json.Unmarshal(value, &raw) != nil || !exactFields(raw.Build, "channel", "version", "commit", "releaseId") {
		return false
	}
	for _, file := range raw.Files {
		if !exactFields(file, "path", "size", "sha256", "mode") {
			return false
		}
	}
	var build Manifest
	if json.Unmarshal(raw.Build, &build) != nil || build.ReleaseID != manifest.ReleaseID ||
		build.Version != manifest.Version || build.Commit != manifest.Commit || build.Channel != manifest.Channel {
		return false
	}
	return (component != "server" || sha256Text.MatchString(raw.PackageID)) &&
		(component != "desktop" || manifest.Platform.OS != "darwin" ||
			raw.UnpackedBundleBytes > 0 && raw.UnpackedBundleBytes <= 2<<30)
}

// SignedIndex проверяет индекс и возвращает оригинальные байты конверта для журнала.
func SignedIndex(data []byte) (Manifest, []byte, error) {
	key, _, err := releaseKey()
	if err != nil {
		return Manifest{}, nil, err
	}
	var index struct {
		Format      int             `json:"format"`
		Channel     string          `json:"channel"`
		PublishedAt string          `json:"publishedAt"`
		Latest      json.RawMessage `json:"latest"`
	}
	if _, err := CanonicalJSON(data); err != nil || !exactFields(data, "format", "channel", "publishedAt", "latest") ||
		json.Unmarshal(data, &index) != nil || (index.Format != 2 && index.Format != 3) {
		return Manifest{}, nil, errors.New("release_channel_invalid")
	}
	manifest, err := VerifyManifest(index.Latest, key)
	if err != nil {
		return Manifest{}, nil, err
	}
	if manifest.Format != index.Format || manifest.Channel != index.Channel ||
		manifest.PublishedAt != index.PublishedAt {
		return Manifest{}, nil, errors.New("release_channel_invalid")
	}
	return manifest, index.Latest, nil
}

// NewReceipt записывает известный сборке способ доставки, без доверия к env или индексу.
func NewReceipt(receipt Receipt) (Receipt, error) {
	receipt.Format = 1
	if releaseDistributionSource == "channel" {
		return receipt, nil
	}
	if releaseDistributionSource != "local-test" && releaseDistributionSource != "candidate-file" {
		return Receipt{}, errors.New("installation_release_trust_mismatch")
	}
	_, fingerprint, err := releaseKey()
	if err != nil {
		return Receipt{}, err
	}
	receipt.Format = 2
	receipt.Source = releaseDistributionSource
	receipt.TrustKeySHA256 = fingerprint
	return receipt, nil
}

func uniqueJSON(decoder *json.Decoder, depth int) (any, error) {
	if depth > 128 {
		return nil, errors.New("release_json_depth_invalid")
	}
	value, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	switch value {
	case json.Delim('{'):
		object := make(map[string]any)
		for decoder.More() {
			key, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			name, ok := key.(string)
			_, exists := object[name]
			if !ok || exists {
				return nil, errors.New("release_json_duplicate")
			}
			child, err := uniqueJSON(decoder, depth+1)
			if err != nil {
				return nil, err
			}
			object[name] = child
		}
		_, err = decoder.Token()
		return object, err
	case json.Delim('['):
		var items []any
		for decoder.More() {
			child, err := uniqueJSON(decoder, depth+1)
			if err != nil {
				return nil, err
			}
			items = append(items, child)
		}
		_, err = decoder.Token()
		return items, err
	default:
		return value, nil
	}
}

// VerifyEnvelope принимает опись с тем же ключом и источником, что у регистрации.
func (layout *Layout) VerifyEnvelope(data []byte) (Manifest, error) {
	key, err := layout.releaseTrust()
	if err != nil {
		return Manifest{}, err
	}
	return VerifyManifest(data, key)
}

// VerifyTrust подтверждает отпечаток ключа, закреплённый в receipt этой установки.
func (layout *Layout) VerifyTrust() error {
	_, err := layout.releaseTrust()
	return err
}

// VerifyInstaller проверяет офлайн-скрипт, подпись и привязку к описи установки.
func (layout *Layout) VerifyInstaller(directory, digest string) error {
	key, err := layout.releaseTrust()
	if err != nil {
		return err
	}
	if !sha256Text.MatchString(digest) || CheckParents(directory) != nil {
		return errors.New("release_installer_signature_invalid")
	}
	script, err := ProveFile(filepath.Join(directory, "grigdesk-install"))
	if err != nil {
		return err
	}
	proof, err := ReadOrdinary(filepath.Join(directory, "grigdesk-install.sha256"), 4096)
	expected := "GrigDesk installer v1\n" + script.SHA256 + "  grigdesk-install\n" + digest + "\n"
	if err != nil || string(proof) != expected {
		return errors.New("release_installer_signature_invalid")
	}
	raw, err := ReadOrdinary(filepath.Join(directory, "grigdesk-install.sig"), 1024)
	if err != nil {
		return err
	}
	signature, err := base64.StdEncoding.Strict().DecodeString(strings.TrimSpace(string(raw)))
	if err != nil || !ed25519.Verify(key, proof, signature) {
		return errors.New("release_installer_signature_invalid")
	}
	return nil
}
