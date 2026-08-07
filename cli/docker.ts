/**
 * Docker plumbing — the only place that knows a palace is backed by a container.
 *
 * Each project gets its own named volume (`mempalace-<slug>`). That volume is a
 * derived artifact: a search index built from the markdown under `.palace/`.
 * Losing it is never data loss, because `palace sync` rebuilds it from the
 * repository. Treat it as a cache, never as the source of truth.
 */

import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * MemPalace mines with a local ONNX embedder that writes tqdm progress bars and
 * a cpuinfo warning to the console on every invocation. None of it is signal.
 */
const NOISE = /(iB\/s|onnx|cpuid_info|^\s*$)/i;

export function stripNoise(output: string): string {
  return output
    .split("\n")
    .filter((line) => !NOISE.test(line))
    .join("\n")
    .trim();
}

function run(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

export async function dockerAvailable(): Promise<boolean> {
  const { code } = await run("docker", ["info"]);
  return code === 0;
}

export async function imageExists(image = "mempalace"): Promise<boolean> {
  const { code, stdout } = await run("docker", ["images", "-q", image]);
  return code === 0 && stdout.trim().length > 0;
}

export async function volumeExists(volume: string): Promise<boolean> {
  const { code } = await run("docker", ["volume", "inspect", volume]);
  return code === 0;
}

export async function createVolume(volume: string): Promise<void> {
  const { code, stderr } = await run("docker", ["volume", "create", volume]);
  if (code !== 0) throw new Error(`Could not create volume ${volume}: ${stderr.trim()}`);
}

/**
 * Whether a lock-contention failure is what killed a mempalace invocation.
 *
 * Only `mine` takes the palace's exclusive lock — verified: two MCP servers run
 * concurrently against one volume without complaint, while two simultaneous
 * miners leave one refused with this message and its drawers unfiled. Worth
 * distinguishing, because it is transient and retrying fixes it.
 */
export function isLockContention(output: string): boolean {
  return /is held by PID|wait for it to finish/i.test(output);
}

/**
 * Invoke the mempalace CLI against a project's palace.
 *
 * The repository is mounted read-only. MemPalace has no business writing into
 * a source tree, and a read-only mount turns that from a promise into a fact.
 */
export async function mempalace(
  args: string[],
  opts: { volume: string; workdir?: string },
): Promise<RunResult> {
  const dockerArgs = ["run", "--rm", "-v", `${opts.volume}:/data`];
  if (opts.workdir) dockerArgs.push("-v", `${opts.workdir}:/work:ro`);
  dockerArgs.push("mempalace", ...args);
  return run("docker", dockerArgs);
}
