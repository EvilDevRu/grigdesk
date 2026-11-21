package installation

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// StageArtifact потоково проверяет архив до раскрытия и допускает только его обычные файлы.
func StageArtifact(ctx context.Context, source, stage, component string, manifest Manifest) error {
	artifact, ok := manifest.Artifacts[component]
	if !ok {
		return errors.New("release_artifact_missing")
	}
	compressed, err := os.CreateTemp(filepath.Dir(stage), ".grigdesk-archive-*")
	if err != nil {
		return err
	}
	defer os.Remove(compressed.Name())
	defer compressed.Close()
	if err := copyVerified(ctx, source, component, artifact, compressed); err != nil {
		return err
	}
	if _, err := compressed.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if err := os.MkdirAll(stage, 0o700); err != nil {
		return err
	}
	return extractFiles(ctx, compressed, stage, artifact)
}

func copyVerified(ctx context.Context, source, component string, artifact Artifact, output *os.File) error {
	opened, err := openArchive(ctx, source, component, artifact)
	if err != nil {
		return err
	}
	defer opened.Close()
	hash := sha256.New()
	limited := io.LimitReader(&cancelReader{ctx, opened}, artifact.Size+1)
	written, err := io.Copy(io.MultiWriter(output, hash), limited)
	if err != nil || written != artifact.Size || hex.EncodeToString(hash.Sum(nil)) != artifact.SHA256 {
		return errors.New("release_artifact_hash_mismatch")
	}
	return nil
}

func openArchive(ctx context.Context, source, component string, artifact Artifact) (io.ReadCloser, error) {
	if source != "" {
		if err := CheckParents(source); err != nil {
			return nil, err
		}
		path := filepath.Join(source, component+".tar.gz")
		file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
		if err != nil {
			return nil, err
		}
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() || info.Size() != artifact.Size {
			_ = file.Close()
			return nil, errors.New("release_artifact_size_mismatch")
		}
		return file, nil
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, artifact.URL, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept-Encoding", "identity")
	client := &http.Client{
		Timeout: 10 * time.Minute,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("release_download_redirect")
		},
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, errors.New("release_download_failed")
	}
	if response.StatusCode != http.StatusOK || response.ContentLength >= 0 && response.ContentLength != artifact.Size {
		_ = response.Body.Close()
		return nil, errors.New("release_download_failed")
	}
	return response.Body, nil
}

func extractFiles(ctx context.Context, source io.Reader, stage string, artifact Artifact) error {
	compressed := bufio.NewReader(source)
	decode, err := gzip.NewReader(compressed)
	if err != nil {
		return errors.New("release_archive_invalid")
	}
	defer decode.Close()
	decode.Multistream(false)
	stream := &cancelReader{ctx, decode}
	reader := tar.NewReader(stream)
	expected := make(map[string]File)
	for _, file := range artifact.Files {
		expected[file.Path] = file
	}
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil || header.Format != tar.FormatUSTAR || header.Typeflag != tar.TypeReg {
			return errors.New("release_archive_entry_invalid")
		}
		file, exists := expected[header.Name]
		if !exists || header.Size != file.Size || header.Mode != int64(file.Mode) ||
			header.Linkname != "" || !validRelative(header.Name) {
			return errors.New("release_archive_entry_invalid")
		}
		if err := extractFile(stage, file, reader); err != nil {
			return err
		}
		delete(expected, header.Name)
	}
	if len(expected) != 0 {
		return errors.New("release_archive_missing_file")
	}
	// После конца ustar разрешено только ограниченное нулевое выравнивание.
	padding, err := io.ReadAll(io.LimitReader(stream, 32<<10+1))
	if err != nil || len(padding) > 32<<10 {
		return errors.New("release_archive_invalid")
	}
	for _, b := range padding {
		if b != 0 {
			return errors.New("release_archive_invalid")
		}
	}
	if _, err := compressed.Peek(1); err != io.EOF {
		return errors.New("release_archive_trailing_data")
	}
	return SyncDirectory(stage)
}

func extractFile(stage string, expected File, source io.Reader) error {
	target := filepath.Join(stage, expected.Path)
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	hash := sha256.New()
	count, err := io.Copy(io.MultiWriter(file, hash), source)
	if err != nil || count != expected.Size || hex.EncodeToString(hash.Sum(nil)) != expected.SHA256 {
		return errors.New("release_file_hash_mismatch")
	}
	mode := os.FileMode(0o444)
	if expected.Mode&0o111 != 0 {
		mode = 0o555
	}
	if err := file.Chmod(mode); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	return SyncDirectory(filepath.Dir(target))
}

type cancelReader struct {
	ctx context.Context
	io.Reader
}

func (reader *cancelReader) Read(buffer []byte) (int, error) {
	if err := reader.ctx.Err(); err != nil {
		return 0, err
	}
	return reader.Reader.Read(buffer)
}
