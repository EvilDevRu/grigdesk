//go:build unix

package host

import (
	"context"
	"errors"
	"fmt"
	"os"
	"slices"
	"strconv"
	"syscall"
	"time"
)

var errNoProcess = errors.New("процесс отсутствует")

// CaptureTree подтверждает новую сессию и снимает независимые identity её участников.
// Запись можно сериализовать для отмены другим координатором.
func CaptureTree(pid int) (TreeOwner, error) {
	boot, err := bootID()
	if err != nil {
		return TreeOwner{}, err
	}
	leader, err := readIdentity(pid, boot)
	if err != nil {
		return TreeOwner{}, err
	}
	witness := TreeOwner{Leader: leader}
	candidates, err := witness.identify()
	if err != nil {
		return TreeOwner{}, err
	}
	witness.Members = candidates
	return witness, nil
}

// StopTree сначала подтверждает точную группу, сессию и поколение владельца.
// Участники сигналятся через pidfd или проверенный Darwin helper, затем проверяется выход.
func StopTree(ctx context.Context, owner TreeOwner, grace time.Duration) error {
	if grace < 0 || grace > time.Minute {
		return fmt.Errorf("%w: неверный grace period", ErrUnconfirmedTree)
	}
	deadline := time.Now().Add(grace)
	killDeadline := deadline.Add(2 * time.Second)
	soft := make(map[ProcessIdentity]bool)
	empty := 0
	for {
		live, err := owner.identify()
		if err != nil {
			return err
		}
		if len(live) == 0 {
			empty++
			if empty == 2 {
				return nil
			}
		} else {
			empty = 0
			if time.Now().After(killDeadline) {
				return fmt.Errorf("%w: сессия ещё жива", ErrUnconfirmedTree)
			}
			if err := signalMembers(live, soft, time.Now().Before(deadline)); err != nil {
				return err
			}
			owner.Members = live
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("%w: %s", ErrUnconfirmedTree, ctx.Err())
		case <-time.After(20 * time.Millisecond):
		}
	}
}

func signalMembers(live []ProcessIdentity, sent map[ProcessIdentity]bool, graceful bool) error {
	for _, process := range live {
		if !graceful {
			if err := signalIdentity(process, syscall.SIGKILL); err != nil {
				return err
			}
			continue
		}
		if sent[process] {
			continue
		}
		if err := signalIdentity(process, syscall.SIGTERM); err != nil {
			return err
		}
		if err := signalIdentity(process, syscall.SIGCONT); err != nil {
			return err
		}
		sent[process] = true
	}
	return nil
}

// identify запрещает собственную сессию и неподтверждённые поколения.
// При выходе лидера нужен хотя бы один ранее наблюдавшийся участник.
func (owner TreeOwner) identify() ([]ProcessIdentity, error) {
	p := owner.Leader
	boot, err := bootID()
	if err != nil || p.PID <= 1 || p.PID != p.Group || p.PID != p.Session ||
		p.UID != os.Geteuid() || p.Start == "" || boot != p.Boot {
		return nil, ErrUnconfirmedTree
	}
	self, err := readIdentity(os.Getpid(), boot)
	if err != nil || self.Session == p.Session {
		return nil, ErrUnconfirmedTree
	}
	leader, err := readIdentity(p.PID, boot)
	if err == nil && !sameProcess(leader, p) {
		return nil, ErrUnconfirmedTree
	}
	if err != nil && !errors.Is(err, errNoProcess) {
		return nil, err
	}
	anchored := err == nil
	rows, err := sessionMembers(p.Session, boot)
	if err != nil {
		return nil, err
	}
	live := make([]ProcessIdentity, 0, len(rows))
	for _, row := range rows {
		if row.UID != p.UID || precedes(row.Start, p.Start) {
			return nil, ErrUnconfirmedTree
		}
		if slices.ContainsFunc(owner.Members, func(witness ProcessIdentity) bool {
			return sameProcess(row, witness)
		}) {
			anchored = true
		}
		if row.State != "Z" && row.State != "X" {
			live = append(live, row)
		}
	}
	if len(live) > 0 && !anchored {
		return nil, ErrUnconfirmedTree
	}
	return live, nil
}

func sameProcess(a, b ProcessIdentity) bool {
	return a.PID == b.PID && a.Group == b.Group && a.Session == b.Session &&
		a.UID == b.UID && a.Start == b.Start && a.Boot == b.Boot
}

func precedes(first, second string) bool {
	a, aErr := strconv.ParseUint(first, 10, 64)
	b, bErr := strconv.ParseUint(second, 10, 64)
	return aErr != nil || bErr != nil || a < b
}

// CurrentIdentity возвращает OS-подтверждённую identity оркестратора для lifecycle.
func CurrentIdentity() (ProcessIdentity, error) {
	boot, err := bootID()
	if err != nil {
		return ProcessIdentity{}, err
	}
	return readIdentity(os.Getpid(), boot)
}

// StillRunning подтверждает личность живого лидера по тому же источнику, что и StopTree.
// Зомби и другой процесс с повторно использованным PID не подтверждают запуск.
func StillRunning(expected ProcessIdentity) bool {
	boot, err := bootID()
	if err != nil || expected.Boot != boot || expected.PID <= 1 ||
		expected.Session != expected.PID || expected.Group != expected.PID || expected.UID != os.Geteuid() {
		return false
	}
	current, err := readIdentity(expected.PID, boot)
	return err == nil && current.State != "Z" && current.State != "X" && sameProcess(current, expected)
}
