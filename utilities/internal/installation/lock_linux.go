package installation

// AcquireLock сохраняет совместимый каталог блокировки старого установщика.
func AcquireLock(path string) (func(), error) {
	return acquireDirectoryLock(path)
}
