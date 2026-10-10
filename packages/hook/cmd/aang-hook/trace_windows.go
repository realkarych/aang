package main

import "syscall"

func processCreated() int64 {
	var creation, exit, kernel, user syscall.Filetime
	handle, _ := syscall.GetCurrentProcess()
	if syscall.GetProcessTimes(handle, &creation, &exit, &kernel, &user) != nil {
		return 0
	}
	return creation.Nanoseconds()
}

func processTimes() (int64, int64) {
	var creation, exit, kernel, user syscall.Filetime
	handle, _ := syscall.GetCurrentProcess()
	if syscall.GetProcessTimes(handle, &creation, &exit, &kernel, &user) != nil {
		return 0, 0
	}
	return int64(kernel.HighDateTime)<<32 | int64(kernel.LowDateTime), int64(user.HighDateTime)<<32 | int64(user.LowDateTime)
}
