# tools/coverage

Merges the raw V8 coverage of one CI part into one file that `c8 report` reads like any other raw file.

```sh
node tools/coverage/dist/main.js coverage/tmp coverage/part/v8.json
```

Run it from the repository root, after a run with `NODE_V8_COVERAGE=coverage/tmp`. It reads `.c8rc.json` from the working directory and, file by file:

- keeps the scripts and `source-map-cache` entries whose file is inside the working directory, matches `include` and matches neither `exclude` nor `**/node_modules/**`;
- merges the kept scripts into the result with `mergeProcessCovs` of `@bcoe/v8-coverage`, the same merge `c8 report` runs with `mergeAsync`;
- skips a file that is not JSON or has no `result` list, as `c8 report` does, and counts it in the summary line.

A directory without coverage files is an error (exit code 1), wrong arguments exit with 2. The CI layout that uses the merged files is described in `e2e/README.md`, sections «CI» and «Покрытие».
