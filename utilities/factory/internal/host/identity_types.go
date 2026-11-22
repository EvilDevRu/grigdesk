package host

import "errors"

type ProcessIdentity struct {
	PID, PPID, Group, Session, UID int
	Start, Boot                    string
	State                          string
}

type TreeOwner struct {
	Leader  ProcessIdentity
	Members []ProcessIdentity
}

var ErrUnconfirmedTree = errors.New("владение процессами не подтверждено")
