//go:build !windows

package main

func processCreated() int64 {
	return 0
}

func parentCreated(int) int64 {
	return 0
}

func processTimes() (int64, int64) {
	return 0, 0
}
