package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

type DeviceArgs struct {
	Action  string
	Value   string
	Address string
	JSON    bool
}

func ParseDevice(argv []string) (DeviceArgs, error) {
	var args DeviceArgs
	if len(argv) == 0 {
		return args, errors.New("Укажите grigdesk-ctl device add <имя> | list | revoke <id>.")
	}
	args.Action, argv = argv[0], argv[1:]
	switch args.Action {
	case "list":
	case "add", "revoke":
		if len(argv) == 0 || strings.HasPrefix(argv[0], "-") || strings.TrimSpace(argv[0]) == "" {
			return args, errors.New("Укажите имя или id: grigdesk-ctl device --help.")
		}
		args.Value, argv = argv[0], argv[1:]
	default:
		return args, errors.New("Укажите grigdesk-ctl device add <имя> | list | revoke <id>.")
	}
	for len(argv) > 0 {
		flag := argv[0]
		argv = argv[1:]
		switch {
		case flag == "--json" && args.Action != "revoke":
			args.JSON = true
		case flag == "--address" && args.Action == "add" && args.Address == "":
			if len(argv) == 0 || argv[0] == "" || strings.HasPrefix(argv[0], "-") {
				return args, errors.New("Укажите host:port после --address. Справка: grigdesk-ctl device --help.")
			}
			args.Address, argv = argv[0], argv[1:]
		default:
			return args, errors.New("Неизвестный аргумент устройства. Справка: grigdesk-ctl device --help.")
		}
	}
	return args, nil
}

type Pairing struct {
	Text string `json:"text"`
	QR   struct {
		Rows []string `json:"rows"`
	} `json:"qr"`
}

// Device использует один и тот же короткий вход для списка, привязки и отзыва.
func Device(ctx context.Context, settings Settings, args DeviceArgs, color bool, term Terminal) int {
	session, err := SignIn(ctx, settings)
	if err != nil {
		return term.Fail(err.Error(), 1)
	}
	endpoint, method, contentType := "/api/devices", http.MethodGet, ""
	var body []byte
	switch args.Action {
	case "add":
		method, endpoint, contentType = http.MethodPost, "/api/devices/pairing", "application/json"
		body, _ = json.Marshal(struct {
			Name    string `json:"name"`
			Address string `json:"address,omitempty"`
		}{args.Value, args.Address})
	case "revoke":
		method, endpoint = http.MethodPost, "/api/devices/"+url.PathEscape(args.Value)+"/revoke"
	}
	reply, err := session.Request(ctx, method, endpoint, contentType, body)
	if err != nil {
		var problem *APIError
		if errors.As(err, &problem) && problem.Code == "client_listener_off" {
			return term.Fail("Откройте «Доступ к серверу» и включите прямой доступ; "+
				"администратор также может задать GRIGDESK_CLIENT_LISTEN.", 1)
		}
		return term.Fail(err.Error(), 1)
	}
	if args.JSON {
		var clean bytes.Buffer
		if err := json.Compact(&clean, reply); err != nil {
			return term.Fail("Некорректный JSON от сервера.", 1)
		}
		return term.Say(clean.String())
	}
	switch args.Action {
	case "add":
		var pairing Pairing
		if err := json.Unmarshal(reply, &pairing); err != nil {
			return term.Fail("Некорректный QR от сервера.", 1)
		}
		if err := WritePairing(term.Stdout, pairing, color); err != nil {
			return term.Fail(err.Error(), 1)
		}
		return 0
	case "list":
		var list struct {
			Devices []struct {
				ID        string `json:"id"`
				Name      string `json:"name"`
				Scope     string `json:"scope"`
				RevokedAt int64  `json:"revokedAt"`
			} `json:"devices"`
		}
		if err := json.Unmarshal(reply, &list); err != nil {
			return term.Fail("Некорректный список устройств.", 1)
		}
		for _, device := range list.Devices {
			suffix := ""
			if device.RevokedAt != 0 {
				suffix = "\tотозвано"
			}
			_, _ = fmt.Fprintf(term.Stdout, "%s\t%s\t%s%s\n", Printable(device.ID), Printable(device.Name),
				Printable(device.Scope), suffix)
		}
		return 0
	default:
		return term.Say("Устройство отозвано.")
	}
}

// WritePairing рисует квадратные модули QR с пустым полем размером четыре модуля.
func WritePairing(out io.Writer, pairing Pairing, color bool) error {
	rows := pairing.QR.Rows
	if len(rows) == 0 || len(rows) > 177 {
		return errors.New("Неверная матрица QR.")
	}
	for _, row := range rows {
		if len(row) != len(rows) || strings.Trim(row, "01") != "" {
			return errors.New("Неверная матрица QR.")
		}
	}
	module := func(y, x int) int {
		if y >= 4 && y < len(rows)+4 && x >= 4 && x < len(rows)+4 && rows[y-4][x-4] == '1' {
			return 1
		}
		return 0
	}
	var result strings.Builder
	blocks := [...]rune{' ', '▀', '▄', '█'}
	for y := 0; y < len(rows)+8; y += 2 {
		if color {
			result.WriteString("\x1b[30;47m")
		}
		for x := 0; x < len(rows)+8; x++ {
			result.WriteRune(blocks[module(y, x)+2*module(y+1, x)])
		}
		if color {
			result.WriteString("\x1b[0m")
		}
		result.WriteByte('\n')
	}
	_, err := fmt.Fprintf(out, "%s%s\nДействует 10 минут, один раз\n", result.String(), Printable(pairing.Text))
	return err
}
