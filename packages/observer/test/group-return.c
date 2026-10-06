#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  useconds_t dwell = (useconds_t)atoi(argv[1]) * 1000;
  pid_t home = getpgrp();
  if (setpgid(0, 0) != 0) return 3;
  usleep(dwell);
  if (setpgid(0, home) != 0) return 4;
  FILE *file = fopen(argv[2], "w");
  if (!file) return 5;
  fprintf(file, "%d", getpid());
  fclose(file);
  usleep(dwell);
  return 0;
}
