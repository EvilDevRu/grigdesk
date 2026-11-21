package install

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"

	"grigdesk.local/tools/utilities/internal/installation"
)

type bundleEntry struct {
	Path   string `json:"relativePath"`
	Kind   string `json:"type"`
	Target string `json:"target"`
	Size   int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
	Mode   uint32 `json:"mode"`
}

const bundleRoot = "grigdesk.app"
const bundleExecutable = "grigdesk.app/Contents/MacOS/grigdesk"

func MaterializeMacDesktop(ctx context.Context, directory string) error {
	index, err := installation.ReadOrdinary(filepath.Join(directory, "GrigDesk.app.tree.json"), 32<<20)
	if err != nil {
		return err
	}
	var tree struct {
		Format  int           `json:"format"`
		Entries []bundleEntry `json:"entries"`
	}
	if json.Unmarshal(index, &tree) != nil || tree.Format != 1 {
		return errors.New("release_mac_app_tree_invalid")
	}
	files, err := indexBundle(tree.Entries)
	if err != nil {
		return err
	}
	archive, err := zip.OpenReader(filepath.Join(directory, "GrigDesk.app.zip"))
	if err != nil {
		return err
	}
	defer archive.Close()
	for _, entry := range tree.Entries {
		if entry.Kind == "directory" {
			if err := os.Mkdir(filepath.Join(directory, entry.Path), 0o755); err != nil {
				return err
			}
		}
	}
	seen := make(map[string]bool)
	for _, wrapped := range archive.File {
		if err := ctx.Err(); err != nil {
			return err
		}
		name := strings.TrimSuffix(wrapped.Name, "/")
		item, ok := files[name]
		if !ok || seen[name] || (item.Kind == "directory") != strings.HasSuffix(wrapped.Name, "/") {
			return errors.New("release_mac_zip_path_invalid")
		}
		if err := extractBundleEntry(directory, wrapped, item); err != nil {
			return err
		}
		seen[name] = true
	}
	for _, entry := range tree.Entries {
		if entry.Kind != "directory" && !seen[entry.Path] {
			return errors.New("release_mac_zip_entry_missing")
		}
	}
	for index := len(tree.Entries) - 1; index >= 0; index-- {
		if tree.Entries[index].Kind == "directory" {
			if err := installation.SyncDirectory(filepath.Join(directory, tree.Entries[index].Path)); err != nil {
				return err
			}
		}
	}
	return verifyMacBundle(ctx, directory)
}

func indexBundle(entries []bundleEntry) (map[string]bundleEntry, error) {
	if len(entries) == 0 || len(entries) > 100_000 {
		return nil, errors.New("release_mac_app_tree_invalid")
	}
	index := make(map[string]bundleEntry)
	folded := make(map[string]bool)
	fold := cases.Lower(language.Und)
	var size int64
	var previous string
	for _, entry := range entries {
		folding := norm.NFC.String(fold.String(norm.NFC.String(entry.Path)))
		parts := strings.Split(entry.Path, "/")
		if len(parts) > 64 || folded[folding] || entry.Path <= previous || len(entry.Path) > 4096 ||
			parts[0] != bundleRoot {
			return nil, errors.New("release_mac_app_path_invalid")
		}
		for _, part := range parts {
			if part == "" || part == "." || part == ".." || len(part) > 255 ||
				strings.ContainsAny(part, "\x00\t\n\r\x7f\\:") {
				return nil, errors.New("release_mac_app_path_invalid")
			}
		}
		if len(parts) > 1 && index[filepath.Dir(entry.Path)].Kind != "directory" {
			return nil, errors.New("release_mac_app_parent_invalid")
		}
		switch entry.Kind {
		case "directory":
		case "file":
			if entry.Size < 0 || entry.Size > (2<<30)-size ||
				!slices.Contains([]uint32{0o444, 0o555, 0o644, 0o755}, entry.Mode) {
				return nil, errors.New("release_mac_app_tree_invalid")
			}
			size += entry.Size
		case "link":
			if !safeBundleLink("desktop/"+entry.Path, entry.Target) {
				return nil, errors.New("release_mac_app_link_invalid")
			}
		default:
			return nil, errors.New("release_mac_app_tree_invalid")
		}
		previous = entry.Path
		index[entry.Path], folded[folding] = entry, true
	}
	if index[bundleRoot].Kind != "directory" || index[bundleExecutable].Kind != "file" ||
		index[bundleExecutable].Mode&0o111 == 0 || index[bundleRoot+"/Contents/Info.plist"].Kind != "file" {
		return nil, errors.New("release_mac_app_tree_invalid")
	}
	for _, entry := range entries {
		if entry.Kind == "link" && !resolveBundleLink(index, entry.Path) {
			return nil, errors.New("release_mac_app_link_invalid")
		}
	}
	return index, nil
}

func resolveBundleLink(index map[string]bundleEntry, name string) bool {
	for range 41 {
		parts := strings.Split(name, "/")
		replaced := false
		for i := range parts {
			prefix := strings.Join(parts[:i+1], "/")
			entry, found := index[prefix]
			if !found {
				return false
			}
			if entry.Kind == "link" {
				name = filepath.Join(filepath.Dir(prefix), entry.Target, strings.Join(parts[i+1:], "/"))
				replaced = true
				break
			}
		}
		if !replaced {
			return true
		}
	}
	return false
}

func extractBundleEntry(directory string, wrapped *zip.File, item bundleEntry) error {
	mode := wrapped.Mode()
	if item.Kind == "directory" {
		if !mode.IsDir() || mode.Perm()&0o022 != 0 || wrapped.UncompressedSize64 != 0 {
			return errors.New("release_mac_zip_type_invalid")
		}
		return nil
	}
	input, err := wrapped.Open()
	if err != nil {
		return err
	}
	defer input.Close()
	target := filepath.Join(directory, item.Path)
	if item.Kind == "link" {
		link, err := io.ReadAll(io.LimitReader(input, 1025))
		if err != nil || mode&os.ModeSymlink == 0 || len(link) > 1024 || string(link) != item.Target {
			return errors.New("release_mac_zip_link_invalid")
		}
		return os.Symlink(item.Target, target)
	}
	if !mode.IsRegular() || uint32(mode.Perm()) != item.Mode || wrapped.UncompressedSize64 != uint64(item.Size) {
		return errors.New("release_mac_zip_type_invalid")
	}
	file, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	digest := sha256.New()
	written, err := io.Copy(io.MultiWriter(file, digest), io.LimitReader(input, item.Size+1))
	if err != nil || written != item.Size || hex.EncodeToString(digest.Sum(nil)) != item.SHA256 {
		return errors.New("release_mac_zip_file_invalid")
	}
	if err := file.Chmod(os.FileMode(item.Mode)); err != nil {
		return err
	}
	return file.Sync()
}

func verifyMacBundle(ctx context.Context, directory string) error {
	name := filepath.Join(directory, bundleExecutable)
	file, err := os.Open(name)
	if err != nil {
		return err
	}
	var header [32]byte
	_, readErr := io.ReadFull(file, header[:])
	_ = file.Close()
	native := binary.LittleEndian
	if readErr != nil || native.Uint32(header[:4]) != 0xfeedfacf ||
		native.Uint32(header[4:8]) != 0x100000c || native.Uint32(header[12:16]) != 2 {
		return errors.New("release_mac_app_binary_invalid")
	}
	bounded, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	app := filepath.Join(directory, bundleRoot)
	info := filepath.Join(app, "Contents", "Info.plist")
	cmd := exec.CommandContext(bounded, "/usr/bin/plutil", "-extract", "CFBundleIdentifier", "raw", "-o", "-", info)
	result, err := cmd.Output()
	if err != nil || strings.TrimSpace(string(result)) != "local.grigdesk.desktop" {
		return errors.New("release_mac_app_identifier_invalid")
	}
	if err := exec.CommandContext(bounded, "/usr/bin/codesign", "--verify", "--deep", "--strict", app).Run(); err != nil {
		return errors.New("release_mac_app_signature_invalid")
	}
	return nil
}

func launchAgent(options Options, receipt installation.Receipt) publication {
	label := "com.grigdesk.server." + receipt.InstallationID
	log := filepath.Join(options.Root, "update", "server.log")
	path := filepath.Join(options.UnitDir, label+".plist")
	var data bytes.Buffer
	xmlText := func(text string) string {
		var out bytes.Buffer
		_ = xml.EscapeText(&out, []byte(text))
		return out.String()
	}
	data.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
		"<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" " +
		"\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n")
	fmt.Fprintf(&data, "<key>Label</key><string>%s</string>\n<key>ProgramArguments</key><array>", xmlText(label))
	home, _ := os.UserHomeDir()
	for _, argv := range []string{"/usr/bin/env", "-i", "HOME=" + canonicalDirectory(home),
		"XDG_CONFIG_HOME=" + macEnvironmentPath("XDG_CONFIG_HOME", filepath.Join(home, ".config")),
		"XDG_DATA_HOME=" + macEnvironmentPath("XDG_DATA_HOME", filepath.Join(home, ".local", "share")),
		"XDG_CACHE_HOME=" + macEnvironmentPath("XDG_CACHE_HOME", filepath.Join(home, ".cache")),
		"TMPDIR=" + canonicalDirectory(os.TempDir()), "GRIGDESK_HOME=" + receipt.DataHome,
		"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "LANG=en_US.UTF-8", "GRIGDESK_LAUNCH_AGENT=" + label,
		"/bin/sh", filepath.Join(options.Root, "bin", "grigdesk-server")} {
		fmt.Fprintf(&data, "<string>%s</string>", xmlText(argv))
	}
	data.WriteString("</array>\n")
	fmt.Fprintf(&data, "<key>WorkingDirectory</key><string>%s</string>\n", xmlText(options.Root))
	fmt.Fprintf(&data, "<key>StandardOutPath</key><string>%s</string>\n", xmlText(log))
	fmt.Fprintf(&data, "<key>StandardErrorPath</key><string>%s</string>\n", xmlText(log))
	data.WriteString("<key>RunAtLoad</key><false/>\n<key>KeepAlive</key><false/>\n" +
		"<key>ExitTimeOut</key><integer>60</integer>\n</dict></plist>\n")
	return publication{Path: path, Bytes: data.Bytes(), Mode: 0o600}
}

func macServiceReceipt(receipt installation.Receipt, agent publication) map[string]any {
	return map[string]any{
		"format": 1, "installationId": receipt.InstallationID, "uid": receipt.UID,
		"plist": agent.Path, "label": "com.grigdesk.server." + receipt.InstallationID,
		"sha256": installation.Hash(agent.Bytes),
	}
}

func macEnvironmentPath(name, fallback string) string {
	if path := os.Getenv(name); path != "" {
		return canonicalDirectory(path)
	}
	return canonicalDirectory(fallback)
}

func canonicalDirectory(path string) string {
	if actual, err := filepath.EvalSymlinks(path); err == nil {
		return actual
	}
	parent := filepath.Dir(path)
	if parent == path {
		return path
	}
	return filepath.Join(canonicalDirectory(parent), filepath.Base(path))
}

// MacDesktopExecutable подбирает файл по внешней подписанной описи и внутреннему дереву приложения.
func MacDesktopExecutable(ctx context.Context, layout *installation.Layout, component string) (string, error) {
	manifest, err := layout.Manifest(component, "desktop")
	if err != nil {
		return "", err
	}
	if err := checkComponent(layout.Receipt.Root, component, manifest.Artifacts["desktop"]); err != nil {
		return "", err
	}
	folder := filepath.Join(layout.Receipt.Root, component)
	if err := VerifyMacDesktop(ctx, folder); err != nil {
		return "", err
	}
	return filepath.Join(folder, bundleExecutable), nil
}

// VerifyMacDesktop сверяет развёрнутый app с подписанным деревом и системной подписью.
func VerifyMacDesktop(ctx context.Context, folder string) error {
	index, err := installation.ReadOrdinary(filepath.Join(folder, "GrigDesk.app.tree.json"), 32<<20)
	if err != nil {
		return err
	}
	var tree struct {
		Format  int           `json:"format"`
		Entries []bundleEntry `json:"entries"`
	}
	if json.Unmarshal(index, &tree) != nil || tree.Format != 1 {
		return errors.New("release_mac_app_tree_invalid")
	}
	entries, err := indexBundle(tree.Entries)
	if err != nil {
		return err
	}
	count := 0
	err = filepath.WalkDir(filepath.Join(folder, bundleRoot), func(name string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		relative, err := filepath.Rel(folder, name)
		item, ok := entries[relative]
		if err != nil || !ok {
			return errors.New("release_mac_app_tree_invalid")
		}
		count++
		switch item.Kind {
		case "directory":
			if !entry.IsDir() {
				return errors.New("release_mac_app_tree_invalid")
			}
		case "link":
			link, err := os.Readlink(name)
			if err != nil || link != item.Target {
				return errors.New("release_mac_app_tree_invalid")
			}
		case "file":
			proof, err := installation.ProveFile(name)
			if err != nil || proof.Size != item.Size || proof.Mode != item.Mode || proof.SHA256 != item.SHA256 {
				return errors.New("release_mac_app_tree_invalid")
			}
		}
		return nil
	})
	if err != nil || count != len(entries) {
		return errors.New("release_mac_app_tree_invalid")
	}
	return verifyMacBundle(ctx, folder)
}
