package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"unicode"

	"github.com/moby/buildkit/frontend/dockerfile/parser"
)

type failure struct {
	Line    int    `json:"line"`
	Message string `json:"message"`
}

type report struct {
	Comments []int    `json:"comments"`
	Error    *failure `json:"error,omitempty"`
}

var byteOrderMark = []byte("\xef\xbb\xbf")

func main() {
	source, err := io.ReadAll(os.Stdin)
	if err == nil {
		err = json.NewEncoder(os.Stdout).Encode(scan(source))
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func scan(source []byte) report {
	result, err := parser.Parse(bytes.NewReader(source))
	if err != nil {
		return report{Comments: []int{}, Error: failureOf(err)}
	}
	lines := bytes.SplitAfter(bytes.TrimPrefix(source, byteOrderMark), []byte("\n"))
	bodies := heredocBodies(result.AST)
	comments := []int{}
	for index := leadingDirectives(lines); index < len(lines); index++ {
		if number := index + 1; !bodies[number] && isComment(lines[index]) {
			comments = append(comments, number)
		}
	}
	return report{Comments: comments}
}

func heredocBodies(root *parser.Node) map[int]bool {
	bodies := map[int]bool{}
	for _, node := range root.Children {
		first := node.EndLine + 1
		for _, heredoc := range node.Heredocs {
			first -= strings.Count(heredoc.Content, "\n") + 1
		}
		for line := first; line <= node.EndLine; line++ {
			bodies[line] = true
		}
	}
	return bodies
}

func leadingDirectives(lines [][]byte) int {
	var directives parser.DirectiveParser
	for index, line := range lines {
		directive, err := directives.ParseLine(bytes.TrimLeftFunc(bytes.TrimRight(line, "\r\n"), unicode.IsSpace))
		if directive == nil || err != nil {
			return index
		}
	}
	return len(lines)
}

func isComment(line []byte) bool {
	return bytes.HasPrefix(bytes.TrimLeftFunc(line, unicode.IsSpace), []byte("#"))
}

func failureOf(err error) *failure {
	line := 1
	var located *parser.LocationError
	if errors.As(err, &located) && len(located.Locations) > 0 && len(located.Locations[0]) > 0 {
		line = max(located.Locations[0][0].Start.Line, 1)
	}
	return &failure{Line: line, Message: err.Error()}
}
