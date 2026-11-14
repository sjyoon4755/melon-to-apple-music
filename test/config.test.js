import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { defaultAppDir, resolveConfig } from "../src/config.js";

test("CLI defaults keep data and state in the home app directory, independent of cwd", () => {
  assert.equal(defaultAppDir, path.join(os.homedir(), ".melon-to-apple-music"));
  const config = resolveConfig({});
  assert.equal(config.root, process.cwd());
  assert.equal(config.dataDir, path.join(defaultAppDir, "data"));
  assert.equal(config.stateDir, path.join(defaultAppDir, ".state"));
});

test("an explicit --data-dir resolves against cwd", () => {
  assert.equal(resolveConfig({ dataDir: "mydata" }).dataDir, path.resolve("mydata"));
});
