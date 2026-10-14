package main

import (
	"os"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	terminatedExitCode = 1
	stopPollInterval   = 10 * time.Millisecond
	creationFlags      = windows.CREATE_SUSPENDED | windows.CREATE_NO_WINDOW | windows.EXTENDED_STARTUPINFO_PRESENT
)

var killOnJobClose = windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
	BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE},
}

type jobAccounting struct {
	totalUserTime             int64
	totalKernelTime           int64
	thisPeriodTotalUserTime   int64
	thisPeriodTotalKernelTime int64
	totalPageFaultCount       uint32
	totalProcesses            uint32
	activeProcesses           uint32
	totalTerminatedProcesses  uint32
}

type processTree struct {
	job        windows.Handle
	root       windows.ProcessInformation
	input      *os.File
	accounting jobAccounting
}

func startTree(command []string) (*processTree, *launchFailure) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, &launchFailure{step: "create_job", err: err}
	}
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&killOnJobClose)), uint32(unsafe.Sizeof(killOnJobClose))); err != nil {
		return nil, &launchFailure{step: "configure_job", err: err}
	}
	input, root, err := createSuspended(command)
	if err != nil {
		return nil, &launchFailure{step: "create_process", err: err}
	}
	if err := windows.AssignProcessToJobObject(job, root.Process); err != nil {
		_ = windows.TerminateProcess(root.Process, terminatedExitCode)
		_, _ = windows.WaitForSingleObject(root.Process, windows.INFINITE)
		return nil, &launchFailure{step: "assign_job", err: err}
	}
	return &processTree{job: job, root: root, input: input}, nil
}

func createSuspended(command []string) (*os.File, windows.ProcessInformation, error) {
	var root windows.ProcessInformation
	application, err := windows.UTF16PtrFromString(command[0])
	if err != nil {
		return nil, root, err
	}
	commandLine, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(command))
	if err != nil {
		return nil, root, err
	}
	reader, writer, err := os.Pipe()
	if err != nil {
		return nil, root, err
	}
	stdio, err := inheritable(windows.Handle(reader.Fd()), windows.Stdout, windows.Stderr)
	if err != nil {
		return nil, root, err
	}
	attributes, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return nil, root, err
	}
	if err := attributes.Update(windows.PROC_THREAD_ATTRIBUTE_HANDLE_LIST, unsafe.Pointer(&stdio[0]), uintptr(len(stdio))*unsafe.Sizeof(stdio[0])); err != nil {
		return nil, root, err
	}
	startup := windows.StartupInfoEx{
		StartupInfo: windows.StartupInfo{
			Cb:        uint32(unsafe.Sizeof(windows.StartupInfoEx{})),
			Flags:     windows.STARTF_USESTDHANDLES,
			StdInput:  stdio[0],
			StdOutput: stdio[1],
			StdErr:    stdio[2],
		},
		ProcThreadAttributeList: attributes.List(),
	}
	err = windows.CreateProcess(application, commandLine, nil, nil, true, creationFlags, nil, nil, &startup.StartupInfo, &root)
	attributes.Delete()
	closeHandles(stdio)
	_ = reader.Close()
	return writer, root, err
}

func inheritable(handles ...windows.Handle) ([]windows.Handle, error) {
	self := windows.CurrentProcess()
	duplicates := make([]windows.Handle, len(handles))
	for index, handle := range handles {
		if err := windows.DuplicateHandle(self, handle, self, &duplicates[index], 0, true, windows.DUPLICATE_SAME_ACCESS); err != nil {
			return nil, err
		}
	}
	return duplicates, nil
}

func closeHandles(handles []windows.Handle) {
	for _, handle := range handles {
		_ = windows.CloseHandle(handle)
	}
}

func (tree *processTree) resume() error {
	_, err := windows.ResumeThread(tree.root.Thread)
	return err
}

func (tree *processTree) awaitRootExitOr(stopRequested <-chan struct{}) {
	rootExited := make(chan struct{})
	go func() {
		_, _ = windows.WaitForSingleObject(tree.root.Process, windows.INFINITE)
		close(rootExited)
	}()
	select {
	case <-rootExited:
	case <-stopRequested:
	}
}

func (tree *processTree) stop() (uint32, error) {
	for {
		active, err := tree.activeProcesses()
		if err != nil {
			return 0, err
		}
		if active == 0 {
			var exitCode uint32
			return exitCode, windows.GetExitCodeProcess(tree.root.Process, &exitCode)
		}
		_ = windows.TerminateJobObject(tree.job, terminatedExitCode)
		time.Sleep(stopPollInterval)
	}
}

func (tree *processTree) activeProcesses() (uint32, error) {
	err := windows.QueryInformationJobObject(tree.job, windows.JobObjectBasicAccountingInformation, uintptr(unsafe.Pointer(&tree.accounting)), uint32(unsafe.Sizeof(tree.accounting)), nil)
	return tree.accounting.activeProcesses, err
}
