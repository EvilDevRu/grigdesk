package tunnel

import (
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Certificate  tls.Certificate
	BrainHash    [sha256.Size]byte
	DeviceHash   [sha256.Size]byte
	Port         int
	HelloTimeout time.Duration
	BrainTimeout time.Duration
	Dead         time.Duration
	Ping         time.Duration
	Idle         time.Duration
	BanWindow    time.Duration
	MaxConnect   int
	MaxPerIP     int
	BanThreshold int
	MaxPending   int
}

var pemBase64 = regexp.MustCompile(`^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$`)

// ReadConfig проверяет пару TLS, хеши и ограниченные настройки сети без открытия порта.
// Сообщения об отклонении не содержат исходных значений.
func ReadConfig(env map[string]string) (Config, error) {
	key, err := pemValue(env, "RELAY_TLS_KEY_B64")
	if err != nil {
		return Config{}, err
	}
	cert, err := pemValue(env, "RELAY_TLS_CERT_B64")
	if err != nil {
		return Config{}, err
	}
	identity, err := tls.X509KeyPair(cert, key)
	if err != nil {
		return Config{}, fmt.Errorf("Некорректная пара ключа и сертификата TLS")
	}
	config := Config{Certificate: identity}
	for _, setting := range []struct {
		name string
		hash *[sha256.Size]byte
	}{
		{"RELAY_BRAIN_TOKEN_SHA256", &config.BrainHash},
		{"RELAY_DEVICE_TOKEN_SHA256", &config.DeviceHash},
	} {
		received, err := hex.DecodeString(env[setting.name])
		if err != nil || len(received) != sha256.Size {
			return Config{}, fmt.Errorf("Некорректная настройка %s", setting.name)
		}
		copy(setting.hash[:], received)
	}
	if err := config.limits(env); err != nil {
		return Config{}, err
	}
	return config, nil
}

// limits перечисляет все числа конфигурации и их прежние верхние пределы.
// Даже неиспользуемый рабочей частью watchdog валидируется перед открытием порта.
func (c *Config) limits(env map[string]string) error {
	for _, item := range []struct {
		name     string
		fallback int
		maximum  int
		out      *int
	}{
		{"RELAY_PORT", 7443, 65535, &c.Port},
		{"RELAY_MAX_CONNECTIONS", 256, 4096, &c.MaxConnect},
		{"RELAY_MAX_PER_IP", 32, 256, &c.MaxPerIP},
		{"RELAY_BAN_THRESHOLD", 20, 1000, &c.BanThreshold},
		{"RELAY_MAX_PENDING", 32, 256, &c.MaxPending},
	} {
		value, err := number(env, item.name, item.fallback, item.maximum)
		if err != nil {
			return err
		}
		*item.out = value
	}
	for _, item := range []struct {
		name     string
		fallback int
		maximum  int
		out      *time.Duration
	}{
		{"RELAY_HELLO_TIMEOUT_MS", 5000, 60000, &c.HelloTimeout},
		{"RELAY_BRAIN_TIMEOUT_MS", 10000, 60000, &c.BrainTimeout},
		{"RELAY_DEAD_MS", 60000, 300000, &c.Dead},
		{"RELAY_PING_MS", 20000, 60000, &c.Ping},
		{"RELAY_IDLE_MS", 1800000, 7200000, &c.Idle},
		{"RELAY_BAN_WINDOW_MS", 600000, 3600000, &c.BanWindow},
	} {
		value, err := number(env, item.name, item.fallback, item.maximum)
		if err != nil {
			return err
		}
		*item.out = time.Duration(value) * time.Millisecond
	}
	_, err := Watchdog(env)
	return err
}

// Watchdog проверяет срок родителя отдельно от ключей TLS.
// Ошибка срока обнаруживается до создания дочернего процесса.
func Watchdog(env map[string]string) (time.Duration, error) {
	value, err := number(env, "RELAY_WATCHDOG_MS", 10000, 60000)
	return time.Duration(value) * time.Millisecond, err
}

// number применяет default только к отсутствующей переменной.
// Пустое значение и значение за пределами допустимого бюджета запрещены.
func number(env map[string]string, name string, fallback, maximum int) (int, error) {
	raw, exists := env[name]
	if !exists {
		return fallback, nil
	}
	raw = strings.TrimSpace(raw)
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil && len(raw) > 2 && raw[0] == '0' && strings.ContainsRune("xXbBoO", rune(raw[1])) {
		var parsed int64
		parsed, err = strconv.ParseInt(raw, 0, 64)
		value = float64(parsed)
	}
	if err != nil || value <= 0 || value > float64(maximum) || math.Trunc(value) != value || strings.Contains(raw, "_") {
		return 0, fmt.Errorf("Некорректная настройка %s", name)
	}
	return int(value), nil
}

// pemValue принимает только канонический base64 в пределах legacy лимита.
// Проверка PEM и соответствия ключа сертификату остаётся у tls.X509KeyPair.
func pemValue(env map[string]string, name string) ([]byte, error) {
	value := env[name]
	if value == "" || len(value) > 65536 || !pemBase64.MatchString(value) {
		return nil, fmt.Errorf("Некорректная настройка %s", name)
	}
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return nil, fmt.Errorf("Некорректная настройка %s", name)
	}
	return decoded, nil
}
