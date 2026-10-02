//go:build !windows

package main

import "os"

func main() {
	hook(os.Args[1:])
}
