//go:build windows

package state

// runGraphModelChild на Windows не используется: графовый модельный порт
// первой поставки работает на Linux и Darwin, тесты сборки unix-only.
func runGraphModelChild() int {
	return 1
}

func runGraphModelRPC() int {
	return 1
}