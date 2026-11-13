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
  await mkdir(path.join(root, ".env"));
  await mkdir(path.join(root, ".state"));
  const configuration = path.join(root, ".state", "browser-config.json");
  await writeFile(configuration, "malformed configuration");
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  for (const args of [["apply", "--execute", "--help"], ["match", "-h"], ["apple-auth", "--help"], ["link-existing", "--confirm", "--help"], ["unlink-existing", "--help"], ["resolve-unavailable", "--confirm", "--help"], ["settle-recovery", "--confirm", "--help"], ["review-recovery-candidate", "--execute", "--help"], ["recover-followup", "--execute", "--help"], ["sync", "--execute", "--help"]]) {
    const output = execFileSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
    assert.match(output, new RegExp(`node src/cli.js ${args[0]}`));
    assert.doesNotMatch(output, /node src\/cli.js configure/);
  }
  assert.deepEqual((await readdir(root)).sort(), [".env", ".state"]);
  assert.deepEqual(await readdir(path.join(root, ".state")), ["browser-config.json"]);
  assert.equal(await readFile(configuration, "utf8"), "malformed configuration");
});
