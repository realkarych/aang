package main

import (
	"bytes"
	"crypto/rand"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

const (
	spoolMagic         = "aang-spool/1"
	temporaryDirectory = "tmp"
	readyDirectory     = "new"
	stoppedMarker      = "stopped"
	leasePrefix        = "lease-"
)

var (
	runtimes          = []string{"claude", "codex"}
	registrationTags  = []string{"plugin", "user"}
	forwardedEnvNames = []string{
		"CLAUDE_CODE_ENTRYPOINT",
		"CLAUDE_AGENT_SDK_VERSION",
		"CLAUDE_CODE_SESSION_ID",
		"CLAUDE_CODE_HOST_SESSION_ID",
		"CLAUDE_PID",
		"CLAUDE_PROJECT_DIR",
		"CLAUDE_PLUGIN_ROOT",
		"AI_AGENT",
		"CODEX_HOME",
		"CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
	}
)

func hook(args []string) {
	startTrace(args)
	defer finishTrace(args)
	defer drainStdin()
	record(args, time.Now())
}

func drainStdin() {
	recover()
	_, _ = io.Copy(io.Discard, stdinTrace)
	mark("drained")
}

func record(args []string, now time.Time) {
	if len(args) != 3 || !slices.Contains(runtimes, args[0]) || !slices.Contains(registrationTags, args[1]) || isObserver() {
		return
	}
	runtime, tag, spool := args[0], args[1], args[2]
	accepted := acceptsEvents(spool, now)
	mark("accepts")
	if accepted {
		deliver(spool, eventName(now), header(runtime, tag))
	}
}

func isObserver() bool {
	return os.Getenv("AANG_OBSERVER") == "1" || os.Getenv("CLAUDE_CODE_ENTRYPOINT") == "aang-observer"
}

func acceptsEvents(spool string, now time.Time) bool {
	entries, err := os.ReadDir(spool)
	if err != nil {
		return false
	}
	leased := false
	for _, entry := range entries {
		if entry.Name() == stoppedMarker {
			return false
		}
		leased = leased || isActiveLease(entry.Name(), now)
	}
	return leased
}

func isActiveLease(name string, now time.Time) bool {
	expiry, isLease := strings.CutPrefix(name, leasePrefix)
	expiresAt, err := strconv.ParseInt(expiry, 10, 64)
	return isLease && err == nil && now.Unix() < expiresAt
}

func eventName(now time.Time) string {
	return strconv.FormatInt(now.UnixNano(), 10) + "-" + rand.Text()
}

func header(runtime, tag string) []byte {
	var text bytes.Buffer
	text.WriteString(spoolMagic + " " + runtime + " " + tag + "\n")
	for _, name := range forwardedEnvNames {
		if value, present := os.LookupEnv(name); present {
			text.WriteString(name + "=" + value + "\x00")
		}
	}
	text.WriteByte(0)
	return text.Bytes()
}

func deliver(spool, name string, header []byte) {
	pending := filepath.Join(spool, temporaryDirectory, name)
	file, err := os.OpenFile(pending, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return
	}
	mark("opened")
	written, copyErr := io.Copy(file, io.MultiReader(bytes.NewReader(header), stdinTrace))
	mark("copied")
	complete := errors.Join(copyErr, file.Close()) == nil && written > int64(len(header))
	mark("closed")
	if !complete || os.Rename(pending, filepath.Join(spool, readyDirectory, name)) != nil {
		_ = os.Remove(pending)
	}
	mark("renamed")
}
