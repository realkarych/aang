package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
)

const (
	launchMode  = "launch"
	launchUsage = "usage: aang-hook launch <status-file> <input-bytes> <program> [argument ...]"
)

const (
	exitStatusWritten = 0
	exitUnconfirmed   = 1
	exitUsage         = 2
)

type launchRequest struct {
	statusPath  string
	inputLength int64
	command     []string
}

type stoppedStatus struct {
	Outcome  string `json:"outcome"`
	ExitCode uint32 `json:"exit_code"`
}

type notStartedStatus struct {
	Outcome string `json:"outcome"`
	Step    string `json:"step"`
	Error   string `json:"error"`
}

type launchFailure struct {
	step string
	err  error
}

func (failure launchFailure) status() notStartedStatus {
	return notStartedStatus{Outcome: "not_started", Step: failure.step, Error: failure.err.Error()}
}

func launch(args []string) int {
	request, valid := parseLaunch(args)
	if !valid {
		_, _ = fmt.Fprintln(os.Stderr, launchUsage)
		return exitUsage
	}
	tree, failure := startTree(request.command)
	if failure != nil {
		return writeStatus(request.statusPath, failure.status())
	}
	resumeErr := tree.resume()
	if resumeErr == nil {
		stopRequested := make(chan struct{})
		go forwardInput(tree.input, request.inputLength, stopRequested)
		tree.awaitRootExitOr(stopRequested)
	}
	exitCode, err := tree.stop()
	switch {
	case err != nil:
		return exitUnconfirmed
	case resumeErr != nil:
		return writeStatus(request.statusPath, launchFailure{step: "resume_process", err: resumeErr}.status())
	default:
		return writeStatus(request.statusPath, stoppedStatus{Outcome: "stopped", ExitCode: exitCode})
	}
}

func parseLaunch(args []string) (launchRequest, bool) {
	if len(args) < 3 || args[0] == "" || args[2] == "" {
		return launchRequest{}, false
	}
	length, err := strconv.ParseUint(args[1], 10, 63)
	return launchRequest{statusPath: args[0], inputLength: int64(length), command: args[2:]}, err == nil
}

func forwardInput(cli io.WriteCloser, length int64, stopRequested chan<- struct{}) {
	input, _ := io.ReadAll(io.LimitReader(os.Stdin, length))
	go deliverInput(cli, input)
	_, _ = io.Copy(io.Discard, os.Stdin)
	close(stopRequested)
}

func deliverInput(cli io.WriteCloser, input []byte) {
	_, _ = cli.Write(input)
	_ = cli.Close()
}

func writeStatus(path string, status any) int {
	content, _ := json.Marshal(status)
	pending := path + ".pending"
	if os.WriteFile(pending, content, 0o600) != nil || os.Rename(pending, path) != nil {
		_ = os.Remove(pending)
		return exitUnconfirmed
	}
	return exitStatusWritten
}
