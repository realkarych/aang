package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

type traceRecord struct {
	Exe       string           `json:"exe"`
	Args      []string         `json:"args"`
	Pid       int              `json:"pid"`
	Ppid      int              `json:"ppid"`
	Created   int64            `json:"created"`
	Parent    int64            `json:"parentCreated"`
	Main      int64            `json:"main"`
	Marks     map[string]int64 `json:"marks"`
	Bytes     int64            `json:"bytes"`
	Event     string           `json:"event"`
	Kernel    int64            `json:"kernel100ns"`
	User      int64            `json:"user100ns"`
	TraceDone int64            `json:"traceDone"`
}

type tracedStdin struct {
	reader io.Reader
	record *traceRecord
	head   bytes.Buffer
}

var (
	currentTrace = &traceRecord{Marks: map[string]int64{}}
	stdinTrace   = &tracedStdin{reader: os.Stdin, record: currentTrace}
	eventPattern = regexp.MustCompile(`"hook_event_name"\s*:\s*"([^"]+)"`)
)

func (traced *tracedStdin) Read(buffer []byte) (int, error) {
	count, err := traced.reader.Read(buffer)
	now := time.Now().UnixNano()
	if count > 0 {
		if _, seen := traced.record.Marks["firstByte"]; !seen {
			traced.record.Marks["firstByte"] = now
		}
		traced.record.Bytes += int64(count)
		if traced.head.Len() < 8192 {
			traced.head.Write(buffer[:count])
		}
	}
	if err == io.EOF {
		if _, seen := traced.record.Marks["eof"]; !seen {
			traced.record.Marks["eof"] = now
		}
	}
	return count, err
}

func mark(name string) {
	currentTrace.Marks[name] = time.Now().UnixNano()
}

func startTrace(args []string) {
	currentTrace.Main = time.Now().UnixNano()
	currentTrace.Args = args
	currentTrace.Pid = os.Getpid()
	currentTrace.Ppid = os.Getppid()
	currentTrace.Exe, _ = os.Executable()
	currentTrace.Created = processCreated()
	currentTrace.Parent = parentCreated(currentTrace.Ppid)
	if len(args) == 3 {
		directory := filepath.Join(filepath.Dir(args[2]), "hook-trace")
		_ = os.MkdirAll(directory, 0o700)
		content, _ := json.Marshal(currentTrace)
		_ = os.WriteFile(filepath.Join(directory, fmt.Sprintf("%d-%d.start", currentTrace.Main, currentTrace.Pid)), content, 0o600)
	}
}

func finishTrace(args []string) {
	if len(args) != 3 {
		return
	}
	if match := eventPattern.FindSubmatch(stdinTrace.head.Bytes()); match != nil {
		currentTrace.Event = string(match[1])
	}
	currentTrace.Kernel, currentTrace.User = processTimes()
	directory := filepath.Join(filepath.Dir(args[2]), "hook-trace")
	_ = os.MkdirAll(directory, 0o700)
	currentTrace.TraceDone = time.Now().UnixNano()
	content, _ := json.Marshal(currentTrace)
	_ = os.WriteFile(filepath.Join(directory, fmt.Sprintf("%d-%d.json", currentTrace.Main, currentTrace.Pid)), content, 0o600)
}
