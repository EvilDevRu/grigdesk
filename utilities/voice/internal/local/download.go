package local

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"syscall"
	"time"

	"grigdesk.local/tools/utilities/voice/internal/voicecore"
)

type DownloadSpec struct {
	URL     string
	Path    string
	SHA256  string
	Bytes   int64
	Timeout time.Duration
	Client  *http.Client
}

var contentRange = regexp.MustCompile(`^bytes ([0-9]+)-([0-9]+)/([0-9]+)$`)
var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

// Download по возможности продолжает существующий префикс с Range.
// Ограничивает одной попыткой перезапуск после 416 или несовпавшего полного кэша.
func Download(ctx context.Context, spec DownloadSpec) error {
	if spec.Bytes <= 0 || !digestPattern.MatchString(spec.SHA256) || spec.URL == "" {
		return voicecore.Failed("Загрузка требует закреплённый размер и SHA-256.")
	}
	if spec.Timeout == 0 {
		spec.Timeout = 15 * time.Minute
	}
	if spec.Client == nil {
		spec.Client = http.DefaultClient
	}
	bounded, cancel := context.WithTimeout(ctx, spec.Timeout)
	defer cancel()
	err := download(bounded, spec)
	if bounded.Err() == nil {
		return err
	}
	if ctx.Err() != nil {
		return voicecore.Failed("Установка отменена. Сохранённый префикс можно докачать повторным запуском.")
	}
	return voicecore.Failed("Истёк срок загрузки модели. Сохранённый префикс можно докачать повторным запуском.")
}

// download проверяет полный файл перед сетью и после записи последнего чанка.
// Невалидный диапазон и обрыв сохраняют имеющийся префикс для отдельного запуска.
func download(ctx context.Context, spec DownloadSpec) error {
	const wasInterrupted = "Загрузка оборвалась; сохранённый префикс будет использован при повторе."
	restarted := false
	for ctx.Err() == nil {
		have, err := cacheSize(spec.Path)
		if err != nil {
			return err
		}
		if have >= spec.Bytes {
			digest, err := fileDigest(ctx, spec.Path)
			if err != nil {
				return err
			}
			if have == spec.Bytes && digest == spec.SHA256 {
				return nil
			}
			if restarted {
				return voicecore.Failed(fmt.Sprintf("SHA-256: ожидалось %s, получено %s.", spec.SHA256, digest))
			}
			if err := reset(spec.Path); err != nil {
				return err
			}
			have, restarted = 0, true
		}

		status, stored, err := downloadChunk(ctx, spec, have)
		if err != nil {
			return err
		}
		if status == http.StatusRequestedRangeNotSatisfiable {
			if restarted {
				return voicecore.Failed("Источник повторно отверг докачку: HTTP 416.")
			}
			if err := reset(spec.Path); err != nil {
				return err
			}
			restarted = true
			continue
		}
		if stored != spec.Bytes {
			return voicecore.Failed(wasInterrupted)
		}
	}
	return ctx.Err()
}

// downloadChunk проверяет статус и Content-Range до открытия назначения.
// Ответ 200 начинает новый префикс, ответ 206 дописывает только согласованный диапазон.
func downloadChunk(ctx context.Context, spec DownloadSpec, offset int64) (int, int64, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, spec.URL, nil)
	if err != nil {
		return 0, 0, err
	}
	if offset > 0 {
		request.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
	}
	response, err := spec.Client.Do(request)
	if err != nil {
		return 0, 0, voicecore.Failed("Загрузка или запись оборвалась; сохранённый префикс доступен при повторе.")
	}
	defer response.Body.Close()
	status := response.StatusCode
	length := spec.Bytes
	switch status {
	case http.StatusRequestedRangeNotSatisfiable:
		return status, offset, nil
	case http.StatusPartialContent:
		length, err = rangeSize(response.Header.Get("Content-Range"), offset, spec.Bytes)
		if err != nil {
			return status, offset, err
		}
	case http.StatusOK:
		offset = 0
	default:
		return status, offset, voicecore.Failed(fmt.Sprintf("Не удалось скачать модель: HTTP %d.", status))
	}
	received, err := writePrefix(spec.Path, response.Body, offset, length)
	return status, offset + received, err
}

// rangeSize проверяет согласованность начала, конца и полного размера пакета.
// Некорректный диапазон отклоняется до изменения кэша.
func rangeSize(value string, first, total int64) (int64, error) {
	parts := contentRange.FindStringSubmatch(value)
	if len(parts) == 4 {
		a, errA := strconv.ParseInt(parts[1], 10, 64)
		b, errB := strconv.ParseInt(parts[2], 10, 64)
		c, errC := strconv.ParseInt(parts[3], 10, 64)
		if errA == nil && errB == nil && errC == nil && a == first && c == total && b >= a && b < total {
			return b - a + 1, nil
		}
	}
	return 0, voicecore.Failed("Источник вернул неверный Content-Range; кэш не изменён.")
}

// writePrefix сохраняет частичные байты на диск даже при сетевом обрыве.
// Открытие без следования ссылке защищает чужое назначение cache-файла.
func writePrefix(path string, input io.Reader, offset, maximum int64) (int64, error) {
	const interrupted = "Загрузка или запись оборвалась; сохранённый префикс доступен при повторе."
	flags := os.O_WRONLY | os.O_CREATE | syscall.O_NOFOLLOW
	if offset > 0 {
		flags |= os.O_APPEND
	} else {
		flags |= os.O_TRUNC
	}
	file, err := os.OpenFile(path, flags, 0o600)
	if err != nil {
		return 0, err
	}
	defer file.Close()
	received, err := io.Copy(file, io.LimitReader(input, maximum))
	if err != nil {
		return received, voicecore.Failed(interrupted)
	}
	var extra [1]byte
	if n, err := input.Read(extra[:]); n != 0 || err != io.EOF {
		if n != 0 {
			return received, voicecore.Failed("Источник превысил закреплённый размер файла.")
		}
		return received, voicecore.Failed(interrupted)
	}
	return received, nil
}

// cacheSize принимает только обычный файл, чтобы исключить ссылки и FIFO.
// Отсутствующий путь представляет пустой префикс.
func cacheSize(path string) (int64, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	if !info.Mode().IsRegular() {
		return 0, voicecore.Failed("Кэш загрузки должен быть обычным файлом.")
	}
	return info.Size(), nil
}

// reset обрезает только обычный cache-файл без следования ссылке.
// Следующая попытка начнётся без Range.
func reset(path string) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	return file.Close()
}

// fileDigest проверяет содержимое потоком до принятия модели.
// Отмена проверяется между частями модели и после полного чтения.
func fileDigest(ctx context.Context, path string) (string, error) {
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return "", err
	}
	defer file.Close()
	digest := sha256.New()
	data := make([]byte, 64*1024)
	for ctx.Err() == nil {
		n, err := file.Read(data)
		_, _ = digest.Write(data[:n])
		if err == io.EOF {
			return hex.EncodeToString(digest.Sum(nil)), ctx.Err()
		}
		if err != nil {
			return "", err
		}
	}
	return "", ctx.Err()
}
