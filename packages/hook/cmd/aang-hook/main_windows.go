package main

import "os"

func main() {
	if len(os.Args) > 1 && os.Args[1] == launchMode {
		os.Exit(launch(os.Args[2:]))
	}
	hook(os.Args[1:])
}
