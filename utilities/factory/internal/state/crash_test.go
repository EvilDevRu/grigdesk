package state

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestPendingTransitionCrash(t *testing.T) {
	for _, point := range []string{"effect-durable", "receipt-durable", "event-durable", "cursor-durable"} {
		t.Run(point, func(t *testing.T) {
			f, input, prior := readyReceiptFixture(t)
			receipt := receiptFixturePath(f)
			_, artifact := receiptFixturePaths(f)
			if err := os.Remove(receipt); err != nil {
				t.Fatal(err)
			}
			if point == "event-durable" || point == "cursor-durable" {
				runEffectAndWait(t, artifact)
				if err := f.store.PreparePending(input); err != nil {
					t.Fatal(err)
				}
			}
			stopAfter(t, filepath.Dir(f.store.ControlDir), point)
			assertCrashBoundary(t, f, prior, point)
			before := stateFixtureHashes(t, f.store.ControlDir)
			if _, err := f.store.ReadStage(input.Task, input.Attempt); err != nil &&
				!(point == "event-durable" && errors.Is(err, ErrStagePending)) {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(before, stateFixtureHashes(t, f.store.ControlDir)) {
				t.Fatal("read-only изменил файлы")
			}
			runResumeChild(t, f, point)
			runResumeChild(t, f, point)
			after, err := f.store.ReadStage(input.Task, input.Attempt)
			want := prior.Sequence + 1
			if point == "effect-durable" {
				want = prior.Sequence
			}
			if err != nil || after.Sequence != want {
				t.Fatalf("resume пропустил доказанный event: before=%d after=%d, ожидалось %d %v",
					prior.Sequence, after.Sequence, want, err)
			}
			t.Logf("stage %d → %d: %s → %s; effect=1",
				prior.Sequence, after.Sequence, prior.HeadEventHash, after.HeadEventHash)
			verifyFileBytes(t, artifact, []byte("effect\n"))
			if _, err := os.Stat(receipt); !os.IsNotExist(err) {
				t.Fatalf("завершённая квитанция осталась: %v", err)
			}
		})
	}
}

func assertCrashBoundary(t *testing.T, fixture historicalFixture, prior StageSnapshot, point string) {
	t.Helper()
	path := receiptFixturePath(fixture)
	_, err := os.Stat(path)
	if (point == "effect-durable" && !os.IsNotExist(err)) || (point != "effect-durable" && err != nil) {
		t.Fatalf("неверная граница receipt %s: %v", point, err)
	}
	cursor, err := fixture.store.ReadStage("51", fixture.active)
	switch point {
	case "effect-durable", "receipt-durable":
		if err != nil || cursor != prior {
			t.Fatalf("до event изменился cursor: %+v %v", cursor, err)
		}
	case "event-durable":
		if !errors.Is(err, ErrStagePending) {
			t.Fatalf("старый pointer после event: %v", err)
		}
	case "cursor-durable":
		if err != nil || cursor.Sequence != prior.Sequence+1 {
			t.Fatalf("новый pointer не подтверждён: %+v %v", cursor, err)
		}
	}
	_, effect := receiptFixturePaths(fixture)
	verifyFileBytes(t, effect, []byte("effect\n"))
}

func TestEffectWriter(t *testing.T) {
	path := os.Getenv("FACTORY_TEST_EFFECT_FILE")
	if path == "" {
		t.Skip("только дочерний режим эффекта")
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := file.WriteString("effect\n"); err != nil {
		t.Fatal(err)
	}
	if err := file.Sync(); err != nil {
		t.Fatal(err)
	}
}

func TestCrashWriter(t *testing.T) {
	root, point := os.Getenv("FACTORY_TEST_CRASH_ROOT"), os.Getenv("FACTORY_TEST_CRASH_POINT")
	if root == "" || point == "" {
		t.Skip("только дочерний режим остановки")
	}
	fixture := crashFixture(root)
	guard, effect := receiptFixturePaths(fixture)
	observe := pauseAfter(point)
	if point == "effect-durable" || point == "receipt-durable" {
		runEffectAndWait(t, effect)
		if err := observe("effect-durable"); err != nil {
			t.Fatal(err)
		}
		cursor, err := fixture.store.ReadStage("51", fixture.active)
		if err != nil {
			t.Fatal(err)
		}
		input := PendingRequest{
			Task: "51", Attempt: fixture.active, ExpectedHead: cursor.HeadEventHash,
			Sequence: cursor.Sequence, Tree: guard,
			Args: []string{"51", fixture.active, cursor.CurrentNode, "done", "0", "", "0", "0", "0", "", "0"},
		}
		if err := fixture.store.preparePendingObserved(input, observe); err != nil {
			t.Fatal(err)
		}
		return
	}
	_, _, rc, err := fixture.store.replayPending("51", fixture.active, guard, observe)
	if rc != 0 || err != nil {
		t.Fatalf("дочерний replay: rc=%d %v", rc, err)
	}
}

func TestResumeWorker(t *testing.T) {
	root := os.Getenv("FACTORY_TEST_RESUME_ROOT")
	if root == "" {
		t.Skip("только дочерний resume")
	}
	fixture := crashFixture(root)
	guard, _ := receiptFixturePaths(fixture)
	cursor, status, rc, err := fixture.store.ReplayPending("51", fixture.active, guard)
	if status == "absent" && rc == 3 && err == nil {
		return
	}
	if rc != 0 || err != nil || status != "committed" {
		t.Fatalf("дочерний resume: %s rc=%d %v", status, rc, err)
	}
	fields := []ProjectionField{{"CHECK", "done"}}
	if err := fixture.store.UpdateProjection("51", fixture.active, fields); err != nil {
		t.Fatal(err)
	}
	if err := fixture.store.AckPending("51", fixture.active, cursor.HeadEventHash); err != nil {
		t.Fatal(err)
	}
}

func crashFixture(root string) historicalFixture {
	return historicalFixture{active: historicalAttemptID,
		store: Store{ControlDir: filepath.Join(root, "control"), StateDir: filepath.Join(root, "state")}}
}

func receiptFixturePaths(f historicalFixture) (string, string) {
	root := filepath.Dir(f.store.ControlDir)
	return filepath.Join(root, "guard.snapshot"), filepath.Join(root, "effect.count")
}

func runEffectAndWait(t *testing.T, target string) {
	t.Helper()
	runChildTest(t, "TestEffectWriter", "FACTORY_TEST_EFFECT_FILE="+target)
}

func runResumeChild(t *testing.T, f historicalFixture, point string) {
	t.Helper()
	runChildTest(t, "TestResumeWorker", "FACTORY_TEST_RESUME_ROOT="+filepath.Dir(f.store.ControlDir))
}

func runChildTest(t *testing.T, name, setting string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^"+name+"$")
	cmd.Env = []string{setting, "PATH=" + os.Getenv("PATH"), "GORACE=atexit_sleep_ms=0"}
	if raw, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("дочерний %s: %v %s", name, err, raw)
	}
}

func pauseAfter(target string) transitionObserver {
	notify := os.NewFile(3, "ready")
	release := os.NewFile(4, "release")
	return func(point string) error {
		if point != target {
			return nil
		}
		if _, err := fmt.Fprintln(notify, point); err != nil {
			return err
		}
		var one [1]byte
		_, err := io.ReadFull(release, one[:])
		return err
	}
}

func stopAfter(t *testing.T, root, point string) {
	t.Helper()
	barrier := makeWriterBarrier(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestCrashWriter$")
	cmd.Env = []string{"FACTORY_TEST_CRASH_ROOT=" + root, "FACTORY_TEST_CRASH_POINT=" + point,
		"PATH=" + os.Getenv("PATH"), "GORACE=atexit_sleep_ms=0"}
	cmd.ExtraFiles = []*os.File{barrier.notify, barrier.allow}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	barrier.notify.Close()
	barrier.allow.Close()
	ready, readErr := bufio.NewReader(barrier.ready).ReadString('\n')
	killErr := cmd.Process.Kill()
	waitErr := cmd.Wait()
	if readErr != nil || ready != point+"\n" || killErr != nil || waitErr == nil || ctx.Err() != nil {
		t.Fatalf("граница %q: ready=%q read=%v kill=%v wait=%v timeout=%v",
			point, ready, readErr, killErr, waitErr, ctx.Err())
	}
}
