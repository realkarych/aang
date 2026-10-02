#include <stdio.h>
#include <stdlib.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 4) return 2;
  pid_t child = fork();
  if (child < 0) return 3;
  if (child == 0) _exit(0);
  if (setpgid(0, 0) != 0) return 4;
  siginfo_t info;
  if (waitid(P_PID, child, &info, WEXITED | WNOWAIT) != 0) return 5;
  FILE *file = fopen(argv[1], "w");
  if (!file) return 6;
  fprintf(file, "%d", child);
  fclose(file);
  file = fopen(argv[2], "w");
  if (!file) return 7;
  fprintf(file, "%d", getpid());
  fclose(file);
  while (access(argv[3], F_OK) != 0) usleep(10000);
  return waitpid(child, NULL, 0) < 0 ? 8 : 0;
}
