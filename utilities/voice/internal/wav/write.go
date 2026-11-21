package wav

import (
	"context"
	"encoding/binary"
	"os"
	"path/filepath"

	"grigdesk.local/tools/utilities/voice/internal/voicecore"
)

const Maximum = 64 * 1024 * 1024

var order = binary.LittleEndian

// Check проверяет границы RIFF, обязательные fmt/data и ненулевую звуковую дорожку.
// Аудио не загружается в память: читаются только заголовки ограниченного числа чанков.
func Check(path string) (int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, voicecore.Failed("Движок не оставил допустимый WAV-файл.")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() < 44 || info.Size() > Maximum {
		return 0, voicecore.Failed("Движок не оставил допустимый WAV-файл.")
	}
	var header [12]byte
	if _, err := file.ReadAt(header[:], 0); err != nil ||
		string(header[:4]) != "RIFF" || string(header[8:]) != "WAVE" {
		return 0, voicecore.Failed("Движок вернул файл другого формата вместо WAV.")
	}
	end := int64(order.Uint32(header[4:])) + 8
	if end > info.Size() || end < 44 {
		return 0, voicecore.Failed("WAV-файл обрезан или повреждён.")
	}
	if err := chunks(file, end); err != nil {
		return 0, err
	}
	return info.Size(), nil
}

// chunks читает только данные, указанные в допустимом RIFF-заголовке.
// Формат и данные должны быть внутри одного законченного контейнера.
func chunks(file *os.File, end int64) error {
	offset, count := int64(12), 0
	hasFormat, hasData := false, false
	for offset+8 <= end {
		var header [8]byte
		_, err := file.ReadAt(header[:], offset)
		size := int64(order.Uint32(header[4:]))
		count++
		if err != nil || offset+8+size > end || count > 4096 {
			return voicecore.Failed("WAV-файл обрезан или повреждён.")
		}
		switch string(header[:4]) {
		case "fmt ":
			if size >= 16 {
				var format [16]byte
				_, err := file.ReadAt(format[:], offset+8)
				hasFormat = err == nil && order.Uint16(format[2:]) > 0 &&
					order.Uint32(format[4:]) > 0 && order.Uint16(format[12:]) > 0
			}
		case "data":
			hasData = hasData || size > 0
		}
		offset += 8 + size + size%2
	}
	if !hasFormat || !hasData || offset != end {
		return voicecore.Failed("WAV-файл не содержит корректной звуковой дорожки.")
	}
	return nil
}

// Publish создаёт приватный временный WAV на том же разделе и проверяет его до rename.
// Прежний выход сохраняется при отказе движка, неправильном формате или отмене.
func Publish(ctx context.Context, output string, produce func(string) error) (voicecore.Result, error) {
	if ctx.Err() != nil {
		return voicecore.Result{}, voicecore.Failed("Операция отменена.")
	}
	target, err := filepath.Abs(output)
	if err != nil {
		return voicecore.Result{}, err
	}
	parent := filepath.Dir(target)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return voicecore.Result{}, err
	}
	work, err := os.MkdirTemp(parent, ".voice-output-")
	if err != nil {
		return voicecore.Result{}, err
	}
	defer os.RemoveAll(work)

	temporary := filepath.Join(work, "audio.wav")
	if err := produce(temporary); err != nil {
		return voicecore.Result{}, err
	}
	if ctx.Err() != nil {
		return voicecore.Result{}, voicecore.Failed("Операция отменена.")
	}
	size, err := Check(temporary)
	if err != nil {
		return voicecore.Result{}, err
	}
	if ctx.Err() != nil {
		return voicecore.Result{}, voicecore.Failed("Операция отменена.")
	}
	if err := os.Rename(temporary, target); err != nil {
		return voicecore.Result{}, err
	}
	return voicecore.Result{File: target, Bytes: size}, nil
}

// NormalizeToken исправляет только шаблон потокового PCM16 mono от Qwen Token Plan.
// Любой другой заголовок остаётся у общей строгой проверки WAV.
func NormalizeToken(path string) error {
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	var header [44]byte
	if _, err := file.ReadAt(header[:], 0); err != nil || string(header[:4]) != "RIFF" ||
		order.Uint32(header[4:]) != 0x7fffffbf || order.Uint32(header[40:]) != 0x7fffff9b {
		return nil
	}
	info, err := file.Stat()
	if err != nil {
		return err
	}
	size := info.Size()
	if string(header[8:16]) != "WAVEfmt " || order.Uint32(header[16:]) != 16 ||
		order.Uint16(header[20:]) != 1 || order.Uint16(header[22:]) != 1 ||
		order.Uint32(header[24:]) != 24000 || order.Uint32(header[28:]) != 48000 ||
		order.Uint16(header[32:]) != 2 || order.Uint16(header[34:]) != 16 ||
		string(header[36:40]) != "data" || size <= 44 || size > Maximum || (size-44)%2 != 0 {
		return voicecore.Failed("Некорректный потоковый WAV Qwen Token Plan.")
	}
	order.PutUint32(header[4:], uint32(size-8))
	order.PutUint32(header[40:], uint32(size-44))
	_, err = file.WriteAt(header[:], 0)
	return err
}
