package main

import "syscall"

func timesOf(handle syscall.Handle) (syscall.Filetime, syscall.Filetime, syscall.Filetime, bool) {
	var creation, exit, kernel, user syscall.Filetime
	if syscall.GetProcessTimes(handle, &creation, &exit, &kernel, &user) != nil {
		return creation, kernel, user, false
	}
	return creation, kernel, user, true
}

func processCreated() int64 {
	handle, _ := syscall.GetCurrentProcess()
	creation, _, _, ok := timesOf(handle)
	if !ok {
		return 0
	}
	return creation.Nanoseconds()
}

func parentCreated(ppid int) int64 {
	handle, err := syscall.OpenProcess(0x1000, false, uint32(ppid))
	if err != nil {
		return 0
	}
	defer syscall.CloseHandle(handle)
	creation, _, _, ok := timesOf(handle)
	if !ok {
		return 0
	}
	return creation.Nanoseconds()
}

func processTimes() (int64, int64) {
	handle, _ := syscall.GetCurrentProcess()
	_, kernel, user, ok := timesOf(handle)
	if !ok {
		return 0, 0
	}
	return int64(kernel.HighDateTime)<<32 | int64(kernel.LowDateTime), int64(user.HighDateTime)<<32 | int64(user.LowDateTime)
}
