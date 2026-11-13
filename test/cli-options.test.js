import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/cli-options.js";

test("accepts package-runner separator and strict known options", () => {
  assert.deepEqual(parseArgs(["--", "--help"]), { command: "--help", options: {} });
  assert.deepEqual(parseArgs(["apply", "--check", "--backend", "web-player", "--limit=2"]), {
    command: "apply",
    options: { check: true, backend: "web-player", limit: 2 }
  });
  assert.deepEqual(parseArgs(["configure", "--browser", "edge"]), {
    command: "configure",
    options: { browser: "edge" }
  });
});

test("inline names, URLs, paths and reasons preserve every equals sign",()=>{
  for(const[command,key,value]of [["apply","name","검토=플레이리스트"],["resolve","apple-url","https://music.apple.com/kr/album/a/1?i=42&x=a=b"],["review","candidates-dir","folder=with=value"],["revise","reason","가수=원곡=대조"]]){
    assert.deepEqual(parseArgs([command,`--${key}=${value}`]),parseArgs([command,`--${key}`,value]));
  }
});

test("command help is read-only even alongside execute or incomplete flags",()=>{
  for(const command of ["match","apply","revise","apple-auth","configure","status"]){
    assert.deepEqual(parseArgs([command,"--help"]),{command:"help",options:{helpCommand:command}});
  }
  assert.deepEqual(parseArgs(["apply","--execute","-h"]),{command:"help",options:{helpCommand:"apply"}});
});

test("rejects unknown, duplicate, invalid numeric, and conflicting options", () => {
  assert.throws(() => parseArgs(["review", "--threshhold", "0.99"]), /알 수 없는 옵션/);
  assert.throws(() => parseArgs(["apply", "--limit", "nope"]), /유효한 숫자/);
  assert.throws(() => parseArgs(["match", "--threshold", "1.1"]), /0 이상 1 이하/);
  assert.throws(() => parseArgs(["apply", "--check", "--execute"]), /함께 사용할 수 없습니다/);
  assert.throws(() => parseArgs(["mvp", "--limit", "2", "--limit", "3"]), /중복/);
  assert.throws(() => parseArgs(["melon-extract", "--browser", "edge"]), /알 수 없는 옵션/);
});

test("review accepts a separate local candidate directory without execute permission", () => {
  assert.deepEqual(parseArgs(["review", "--candidates-dir", "recent/data"]).options, { candidatesDir: "recent/data" });
  assert.throws(() => parseArgs(["review", "--candidates-dir"]), /값이 필요/);
  assert.throws(() => parseArgs(["review", "--execute"]), /알 수 없는 옵션/);
});

test("max-add accepts only positive safe integers on apply", () => {
  for (const mode of ["--dry-run", "--check", "--execute"]) {
    assert.deepEqual(parseArgs(["apply", mode, "--limit=100", "--max-add", "2"]).options,
      { [mode.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]: true, limit: 100, maxAdd: 2 });
  }
  for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "nope", "", "9007199254740992"]) {
    assert.throws(() => parseArgs(["apply", `--max-add=${value}`]), /max-add/);
  }
  assert.throws(() => parseArgs(["apply", "--max-add"]), /값이 필요/);
  assert.throws(() => parseArgs(["apply", "--max-add=2", "--max-add=3"]), /중복/);
  assert.throws(() => parseArgs(["match", "--max-add=2"]), /알 수 없는 옵션/);
});

test("revise accepts explicit hold or candidate, reason, and bound confirmation flags", () => {
  assert.deepEqual(parseArgs(["revise", "--melon-song-id", "1", "--hold", "--reason", "Edition differs"]).options,
    { melonSongId: "1", hold: true, reason: "Edition differs" });
  assert.deepEqual(parseArgs(["revise", "--melon-song-id=1", "--apple-song-id=9", "--reason=Corrected", "--confirm", "--expected-preview=hash"]).options,
    { melonSongId: "1", appleSongId: "9", reason: "Corrected", confirm: true, expectedPreview: "hash" });
  assert.throws(() => parseArgs(["revise", "--execute"]), /알 수 없는 옵션/);
  assert.throws(() => parseArgs(["resolve", "--hold"]), /알 수 없는 옵션/);
  assert.throws(() => parseArgs(["revise", "--hold=false"]), /값을 지정하지/);
  assert.throws(() => parseArgs(["revise", "--reason"]), /값이 필요/);
});

test("resolve decisions file excludes single-song options and needs confirm with a preview hash", () => {
  assert.deepEqual(parseArgs(["resolve", "--decisions-file", "d.json"]).options, { decisionsFile: "d.json" });
  assert.deepEqual(parseArgs(["resolve", "--decisions-file", "d.json", "--confirm", "--expected-preview", "abc"]).options,
    { decisionsFile: "d.json", confirm: true, expectedPreview: "abc" });
  assert.throws(() => parseArgs(["resolve", "--decisions-file", "d.json", "--melon-song-id", "1"]), /함께 사용할 수 없습니다/);
  assert.throws(() => parseArgs(["resolve", "--decisions-file", "d.json", "--confirm"]), /--expected-preview/);
  assert.throws(() => parseArgs(["resolve", "--decisions-file", "d.json", "--expected-preview", "abc"]), /--confirm/);
});
