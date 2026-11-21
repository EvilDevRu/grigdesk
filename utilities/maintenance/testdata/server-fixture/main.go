package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var version = "0.2.0"

func readJSON(name string) map[string]any {
	content, err := os.ReadFile(name)
	if err != nil {
		panic(err)
	}
	var value map[string]any
	if err := json.Unmarshal(content, &value); err != nil {
		panic(err)
	}
	return value
}

func main() {
	packageID := strings.Repeat("b", 64)
	if len(os.Args) == 3 && os.Args[1] == "--version" && os.Args[2] == "--json" {
		// Реальный сервер выдаёт объект Node runtime. Строку "go" выдаёт только ctl.
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{
			"version":   version,
			"packageId": packageID,
			"runtime":   map[string]string{"node": "24.21.0", "platform": "linux", "arch": "x64"},
		})
		return
	}

	binary, err := os.Executable()
	if err != nil {
		panic(err)
	}
	root := binary
	for range 5 {
		root = filepath.Dir(root)
	}
	data := os.Getenv("GRIGDESK_HOME")
	content, err := os.ReadFile(filepath.Join(data, ".env"))
	if err != nil {
		panic(err)
	}
	port := strings.TrimSpace(strings.TrimPrefix(string(content), "GRIGDESK_PORT="))
	listener, err := net.Listen("tcp4", "127.0.0.1:"+port)
	if err != nil {
		panic(err)
	}
	receipt := readJSON(filepath.Join(root, "installation.json"))
	id := "50bdb29e-1c83-47bc-a001-2b80af4f10c1"
	if version != "0.2.0" {
		id = "79d05129-d470-4ab6-9582-b15eabb21034"
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		if request.URL.Path != "/api/health" && request.Header.Get("X-GrigDesk-Token") != "fixture-drain-token" {
			writer.WriteHeader(http.StatusForbidden)
			return
		}
		switch request.URL.Path {
		case "/api/health":
			_, _ = fmt.Fprintln(writer, "{\"ok\":true}")
		case "/api/system/runtime-identity":
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"installationId": receipt["installationId"], "instanceId": id, "productVersion": version,
				"pid": os.Getpid(), "binary": binary, "owner": "manual", "packageId": packageID,
			})
		case "/api/chat/active":
			_, _ = fmt.Fprintln(writer, "{\"active\":[],\"queued\":[]}")
		case "/api/tasks":
			_, _ = fmt.Fprintln(writer, "{\"tasks\":[]}")
		case "/api/system/update-drain":
			var requestBody map[string]any
			var body map[string]any
			job := readJSON(filepath.Join(root, "update", "job.json"))
			if err := json.NewDecoder(request.Body).Decode(&requestBody); err != nil ||
				request.Method != http.MethodPost || requestBody["jobId"] != job["id"] ||
				requestBody["installationId"] != receipt["installationId"] ||
				requestBody["manifestDigest"] != job["manifestDigest"] || job["stage"] != "stopping" {
				writer.WriteHeader(http.StatusConflict)
				return
			}
			intent, ok := job["intent"].(map[string]any)
			if !ok {
				writer.WriteHeader(http.StatusConflict)
				return
			}
			body = map[string]any{"jobId": job["id"], "nonce": intent["nonce"], "instanceId": id, "success": true}
			writer.WriteHeader(http.StatusAccepted)
			_, _ = fmt.Fprintln(writer, "{\"ok\":true}")
			time.AfterFunc(120*time.Millisecond, func() {
				data, _ := json.Marshal(body)
				if err := os.WriteFile(filepath.Join(root, "update", "server-drain.json"), data, 0o600); err != nil {
					os.Exit(75)
				}
				os.Exit(0)
			})
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	})
	_ = http.Serve(listener, mux)
}
