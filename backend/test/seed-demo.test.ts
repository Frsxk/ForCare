import { afterAll, expect, test } from "bun:test";
import { access, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const backendDir = new URL("..", import.meta.url).pathname;
const repositoryRoot = new URL("../..", import.meta.url).pathname;
const outputName = "seed-credentials-must-not-exist.json";

const scratchDirs: string[] = [];

afterAll(async () => {
  for (const dir of scratchDirs) await rm(dir, { recursive: true, force: true });
});

function runSeed(output: string, env: Record<string, string>) {
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "scripts/seed-demo.ts",
      "--confirm",
      "synthetic-demo-nurses",
      "--output",
      output,
      "--operator",
      "seed-guard-test",
      "--approval-ref",
      "approval-seed-guard",
    ],
    {
      cwd: backendDir,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        AUTH_NURSE_EMAIL_DOMAIN: "nurse.invalid",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
}

test("rejects a lexically outside output whose symlinked parent resolves inside the repository", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "forcare-seed-guard-"));
  scratchDirs.push(scratch);
  const link = join(scratch, "repository-link");
  await symlink(repositoryRoot, link, "dir");
  const output = join(link, "backend", outputName);

  const [stdout, stderr, exitCode] = await runSeed(output, {});
  expect(exitCode).not.toBe(0);
  expect(`${stdout}\n${stderr}`).toContain("--output must be outside the repository");
  expect(`${stdout}\n${stderr}`).not.toContain("Invalid server configuration");
  await expect(access(join(repositoryRoot, "backend", outputName))).rejects.toThrow();
}, 30_000);

test("still accepts a real outside output path before database configuration", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "forcare-seed-guard-"));
  scratchDirs.push(scratch);
  const output = join(scratch, "credentials.json");

  const [stdout, stderr, exitCode] = await runSeed(output, {});
  expect(exitCode).not.toBe(0);
  expect(`${stdout}\n${stderr}`).toContain("Invalid server configuration");
  expect(`${stdout}\n${stderr}`).not.toContain("--output must be outside the repository");
}, 30_000);
