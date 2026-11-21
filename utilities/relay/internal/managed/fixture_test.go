package managed

import (
	"context"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"syscall"
	"testing"

	"grigdesk.local/tools/utilities/internal/grigdeskapi/localapi"
	"grigdesk.local/tools/utilities/relay/internal/tunnel"
)

var fixtureAddress = flag.String("fixture-address", "", "Адрес изолированного loopback.")
var fixtureProof = flag.String("fixture-proof", "", "Синтетическая квитанция установки.")

// TestServeFixture запускает рабочий wire-протокол для фикстуры, в которой mock SSH
// устанавливает синтетический артефакт. Проверку реального ELF выполняет отдельный тест.
func TestServeFixture(t *testing.T) {
	if *fixtureAddress == "" {
		return
	}
	host, _, err := net.SplitHostPort(*fixtureAddress)
	if err != nil || !net.ParseIP(host).IsLoopback() {
		t.Fatal("Фикстура должна использовать loopback")
	}
	config, err := tunnel.ReadConfig(localapi.ProcessEnv())
	if err != nil {
		t.Fatal(err)
	}
	var proof claim
	if err := readJSON(*fixtureProof, uint32(os.Getuid()), 0o640, &proof); err != nil {
		t.Fatal(err)
	}
	secret, ok := proofValue(proof.Secret)
	if !ok {
		t.Fatal("Некорректный секрет фикстуры")
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	listener, err := (&net.ListenConfig{}).Listen(ctx, "tcp4", *fixtureAddress)
	if err != nil {
		t.Fatal(err)
	}
	log := func(event string, port int) { fmt.Printf("{\"ev\":%q,\"port\":%d}\n", event, port) }
	if err := tunnel.ServeListener(ctx, listener, config, log, proof.reply(secret), func() {}); err != nil {
		t.Fatal(err)
	}
}
