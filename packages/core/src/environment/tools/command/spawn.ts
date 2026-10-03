import { spawn, type ChildProcess } from "node:child_process";

export interface CommandSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  detached: boolean;
  stdio: ["pipe", "pipe", "pipe"];
  windowsHide: true;
  shell: false;
}

export type CommandSpawnImplementation = (
  command: string,
  args: string[],
  options: CommandSpawnOptions,
) => ChildProcess;

/**
 * Paths that could be reinterpreted as shell syntax are refused at the process boundary.
 * `spawn` is called with `shell: false`, so these characters are not expanded today; keeping
 * the executable-path contract narrow also makes a later wrapper change fail closed. Spaces,
 * Unicode path text, drive prefixes, both separator styles, and common parentheses remain
 * valid (for example `C:\Program Files (x86)\Git\bin\bash.exe`).
 */
export function isSafeSpawnPath(command: string): boolean {
  if (command.length === 0 || command.trim() !== command) return false;
  return !/[\u0000-\u001f\u007f\u2028\u2029\p{Cf};|&<>$`'"%!^*?\[\]{}]/u.test(command);
}

/**
 * Validates the exact executable after confinement rewrites argv, then launches it with the
 * Windows hidden-console flag. Node maps `windowsHide: true` to CREATE_NO_WINDOW on Windows.
 * `spawnImpl` is a narrow test seam so rejection can be proven to happen before launch.
 */
export function spawnCommandProcess(
  command: string,
  args: string[],
  options: Omit<CommandSpawnOptions, "windowsHide" | "shell">,
  spawnImpl: CommandSpawnImplementation = (program, argv, spawnOptions) =>
    spawn(program, argv, spawnOptions),
): ChildProcess {
  if (!isSafeSpawnPath(command)) {
    throw new Error("refusing to spawn an executable path containing unsafe characters");
  }
  return spawnImpl(command, args, { ...options, windowsHide: true, shell: false });
}
