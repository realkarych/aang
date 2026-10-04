package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const failureExitCode = 127

type target struct {
	Command string   `json:"command"`
	Args    []string `json:"args"`
}

func main() {
	os.Exit(run())
}

func run() int {
	configured, err := readTarget()
	if err != nil {
		return fail(err)
	}
	child := exec.Command(configured.Command, append(configured.Args, os.Args[1:]...)...)
	child.Stdin, child.Stdout, child.Stderr = os.Stdin, os.Stdout, os.Stderr
	err = child.Run()
	var exited *exec.ExitError
	switch {
	case errors.As(err, &exited):
		return exited.ExitCode()
	case err != nil:
		return fail(err)
	default:
		return 0
	}
}

func readTarget() (target, error) {
	self, err := os.Executable()
	if err != nil {
		return target{}, err
	}
	content, err := os.ReadFile(strings.TrimSuffix(self, filepath.Ext(self)) + ".json")
	if err != nil {
		return target{}, err
	}
	var configured target
	if err := json.Unmarshal(content, &configured); err != nil {
		return target{}, err
	}
	if configured.Command == "" {
		return target{}, errors.New("no command")
	}
	return configured, nil
}

func fail(err error) int {
	_, _ = fmt.Fprintln(os.Stderr, "exec-shim:", err)
	return failureExitCode
}
