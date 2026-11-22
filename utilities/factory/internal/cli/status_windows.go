package cli

import "errors"

func readStatusCapability(_ string) (string, error) {
	return "", errors.New("Windows: для результата этапа нужен режим очереди")
}
