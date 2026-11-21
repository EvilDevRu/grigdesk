package installation

func (executable *Executable) execPath() (string, error) {
	return descriptorPath(executable.file.Fd()), nil
}
