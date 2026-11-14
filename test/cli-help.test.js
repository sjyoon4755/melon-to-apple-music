import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("command help works before environment and browser configuration reads, even beside execute", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "melon-cli-help-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appDir = path.join(root, ".melon-to-apple-music");
  await mkdir(path.join(appDir, ".env"), { recursive: true });
  await mkdir(path.join(appDir, ".state"));
  const configuration = path.join(appDir, ".state", "browser-config.json");
  await writeFile(configuration, "malformed configuration");
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const env = { ...process.env, HOME: root, USERPROFILE: root };
  for (const args of [["apply", "--execute", "--help"], ["match", "-h"], ["apple-auth", "--help"], ["link-existing", "--confirm", "--help"], ["unlink-existing", "--help"], ["resolve-unavailable", "--confirm", "--help"], ["settle-recovery", "--confirm", "--help"], ["review-recovery-candidate", "--execute", "--help"], ["recover-followup", "--execute", "--help"], ["sync", "--execute", "--help"]]) {
    const output = execFileSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: "utf8" });
    assert.match(output, new RegExp(`melon-to-apple-music ${args[0]}`));
    assert.doesNotMatch(output, /melon-to-apple-music configure/);
  }
  assert.deepEqual(await readdir(root), [".melon-to-apple-music"]);
  assert.deepEqual((await readdir(appDir)).sort(), [".env", ".state"]);
  assert.deepEqual(await readdir(path.join(appDir, ".state")), ["browser-config.json"]);
  assert.equal(await readFile(configuration, "utf8"), "malformed configuration");
});
