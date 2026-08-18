import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 1024 * 1024;

export function executeShell(
    command: string,
    timeoutMs: number,
    onDelta?: (delta: string) => void,
): Promise<{stdout: string, stderr: string, exitCode: number}> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["-lc", command], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(124);
    }, timeoutMs);
    child.stdout.on("data", (buf: Buffer) => {
      const text = buf.toString();
      stdout += text;
      onDelta?.(text);
      if (stdout.length + stderr.length > MAX_OUTPUT_BYTES) child.kill("SIGKILL");
    });
    child.stderr.on("data", (buf: Buffer) => {
      const text = buf.toString();
      stderr += text;
      onDelta?.(text);
      if (stdout.length + stderr.length > MAX_OUTPUT_BYTES) child.kill("SIGKILL");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}
