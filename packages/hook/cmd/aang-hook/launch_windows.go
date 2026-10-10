package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"sync"
)

const (
	launchMode    = "launch"
	streamedInput = "stream"
	launchUsage   = "usage: aang-hook launch <status-file> <input-bytes|stream> <program> [argument ...]"
)

const streamChunkSize = 64 * 1024

const (
	exitStatusWritten = 0
	exitUnconfirmed   = 1
	exitUsage         = 2
)

type launchRequest struct {
	statusPath  string
	inputLength int64
	streamed    bool
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
		if request.streamed {
			go streamInput(tree.input, stopRequested)
		} else {
			go forwardInput(tree.input, request.inputLength, stopRequested)
		}
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
	request := launchRequest{statusPath: args[0], streamed: args[1] == streamedInput, command: args[2:]}
	if request.streamed {
		return request, true
	}
	length, err := strconv.ParseUint(args[1], 10, 63)
	request.inputLength = int64(length)
	return request, err == nil
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

func streamInput(cli io.WriteCloser, stopRequested chan<- struct{}) {
	queue := newInputQueue()
	go queue.deliver(cli)
	chunk := make([]byte, streamChunkSize)
	for {
		count, err := os.Stdin.Read(chunk)
		queue.push(chunk[:count])
		if err != nil {
			break
		}
	}
	queue.close()
	close(stopRequested)
}

type inputQueue struct {
	mutex   sync.Mutex
	pending *sync.Cond
	chunks  [][]byte
	closed  bool
}

func newInputQueue() *inputQueue {
	queue := &inputQueue{}
	queue.pending = sync.NewCond(&queue.mutex)
	return queue
}

func (queue *inputQueue) push(chunk []byte) {
	if len(chunk) == 0 {
		return
	}
	queue.mutex.Lock()
	queue.chunks = append(queue.chunks, bytes.Clone(chunk))
	queue.mutex.Unlock()
	queue.pending.Signal()
}

func (queue *inputQueue) close() {
	queue.mutex.Lock()
	queue.closed = true
	queue.mutex.Unlock()
	queue.pending.Signal()
}

func (queue *inputQueue) next() ([]byte, bool) {
	queue.mutex.Lock()
	defer queue.mutex.Unlock()
	for len(queue.chunks) == 0 && !queue.closed {
		queue.pending.Wait()
	}
	if len(queue.chunks) == 0 {
		return nil, false
	}
	chunk := queue.chunks[0]
	queue.chunks = queue.chunks[1:]
	return chunk, true
}

func (queue *inputQueue) deliver(cli io.WriteCloser) {
	for chunk, more := queue.next(); more; chunk, more = queue.next() {
		if _, err := cli.Write(chunk); err != nil {
			break
		}
	}
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
