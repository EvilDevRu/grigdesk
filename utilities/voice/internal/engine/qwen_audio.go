package engine

import (
	"context"
	"encoding/json"
	jsonv2 "encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"time"

	"grigdesk.local/tools/utilities/internal/grigdeskapi"
	"grigdesk.local/tools/utilities/voice/internal/voicecore"
	"grigdesk.local/tools/utilities/voice/internal/wav"
)

// audio использует один дедлайн для запроса синтеза, скачивания и записи WAV.
// Ключ передаётся только в одном POST по адресу настроенного сервиса.
func (qwen Qwen) audio(
	ctx context.Context, endpoint, output string, input any, normalize bool,
) (voicecore.Result, error) {
	bounded, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	address, err := qwen.audioURL(bounded, endpoint, input)
	if err != nil {
		return voicecore.Result{}, audioFailure(ctx, bounded, err)
	}
	result, err := wav.Publish(bounded, output, func(file string) error {
		if err := downloadAudio(bounded, address, file); err != nil {
			return err
		}
		if normalize {
			return wav.NormalizeToken(file)
		}
		return nil
	})
	if err != nil {
		return voicecore.Result{}, audioFailure(ctx, bounded, err)
	}
	return result, nil
}

// audioURL получает только ссылку на подготовленный файл, без передачи чужого HTTP-тела наружу.
// Перенаправление POST прекращает попытку, а допустимая ссылка не содержит учётных данных.
func (qwen Qwen) audioURL(ctx context.Context, endpoint string, input any) (string, error) {
	data, err := jsonv2.Marshal(struct {
		Model string `json:"model"`
		Input any    `json:"input"`
	}{Model: qwen.Meta().Model, Input: input})
	if err != nil {
		return "", err
	}
	headers := http.Header{
		"Authorization": []string{"Bearer " + qwen.Key},
		"Content-Type":  []string{"application/json"},
	}
	policy := grigdeskapi.Policy{Header: headers, ReadLimit: successfulBody}
	response, err := grigdeskapi.Request(ctx, http.MethodPost, qwen.BaseURL+endpoint, data, policy)
	if err != nil {
		return "", err
	}
	if response.Status >= 300 && response.Status < 400 {
		return "", errors.New("Qwen перенаправил POST.")
	}
	if response.Status < 200 || response.Status >= 300 {
		return "", voicecore.Failed(fmt.Sprintf("Сервис Qwen ответил HTTP %d.", response.Status))
	}
	var reply struct {
		Output struct {
			Audio struct {
				URL string `json:"url"`
			} `json:"audio"`
		} `json:"output"`
	}
	if err := json.Unmarshal(response.Body, &reply); err != nil {
		return "", err
	}
	if reply.Output.Audio.URL == "" {
		return "", voicecore.Failed("Сервис Qwen не вернул адрес аудио.")
	}
	address, err := url.Parse(reply.Output.Audio.URL)
	if err != nil {
		return "", err
	}
	if !allowedAudioURL(address) {
		return "", voicecore.Failed("Сервис Qwen вернул недопустимый адрес аудио.")
	}
	return address.String(), nil
}

func successfulBody(status int, _ http.Header) int64 {
	if status >= 200 && status < 300 {
		return -1
	}
	return 0
}

func allowedAudioURL(address *url.URL) bool {
	return (address.Scheme == "https" || address.Scheme == "http") && address.User == nil && address.Host != ""
}

// downloadAudio читает WAV потоком, используя одно соединение на каждый разрешённый GET.
// В запросе на скачивание и любом его перенаправлении отсутствует Authorization.
func downloadAudio(ctx context.Context, address, file string) error {
	transport := &http.Transport{DisableKeepAlives: true}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport: transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > 20 || !allowedAudioURL(req.URL) {
				return errors.New("Неверное перенаправление аудио Qwen.")
			}
			return nil
		},
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return voicecore.Failed(fmt.Sprintf("Скачивание аудио Qwen: HTTP %d.", response.StatusCode))
	}
	return writeAudio(file, response.Body)
}

// writeAudio создаёт только приватный WAV, принадлежащий вызову wav.Publish.
// Предел относится к реально полученным байтам, а не к Content-Length.
func writeAudio(path string, source io.Reader) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	size, copyError := io.Copy(file, io.LimitReader(source, wav.Maximum+1))
	closeError := file.Close()
	if size > wav.Maximum {
		return voicecore.Failed("Аудио Qwen превышает допустимый размер.")
	}
	return errors.Join(copyError, closeError)
}

// audioFailure выдаёт только согласованную причину и различает общий срок и сигнал.
// Внешние исключения могут содержать адрес или ключ и не печатаются.
func audioFailure(parent, bounded context.Context, err error) error {
	if parent.Err() != nil {
		return voicecore.Failed("Операция отменена.")
	}
	if errors.Is(bounded.Err(), context.DeadlineExceeded) {
		return voicecore.Failed("Истёк срок запроса Qwen.")
	}
	var failure *voicecore.Failure
	if errors.As(err, &failure) {
		return failure
	}
	return voicecore.Failed("Не удалось получить речь от сервиса Qwen.")
}
