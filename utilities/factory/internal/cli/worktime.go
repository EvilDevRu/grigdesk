package cli

import (
	"fmt"
	"io"
)

func workTime(r request, out, diagnostic io.Writer) int {
	if !taskID.MatchString(r.task) || !attemptID.MatchString(r.value("--attempt")) ||
		r.has("--route", "--ticket-json", "--format", "--node", "--decision", "--comment", "--reason",
			"--actor", "--instrumentation-file", "--delivery-target", "--task-comment", "--visit",
			"--stop-hash", "--answer-file") {
		return fail(diagnostic, fmt.Errorf("work-time требует точную задачу и --attempt"))
	}
	input := makeLaunchRequest(r, diagnostic)
	timing, err := input.Store.ReadWorkTime(r.task, input.Attempt, input.Profile, r.value("--routes-dir"))
	if err != nil {
		return fail(diagnostic, err)
	}
	const format = "work_time_s=%d\ngate_wait_s=%d\nlast_event_at=%d"
	stats := fmt.Sprintf(format, timing.Work, timing.Gate, timing.Last)
	return printLine(out, stats)
}
