package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println("runtime-check-fixture 1.0")
		return
	}
	if len(os.Args) == 4 && os.Args[1] == "debug" && os.Args[2] == "models" && os.Args[3] == "--bundled" {
		fmt.Println(`{"models":[{"slug":"gpt-6.1-sol"}]}`)
		return
	}
	os.Exit(73)
}
