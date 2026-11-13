import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../src/config.js";
import { readMatchSelection } from "../src/match-decisions.js";
import { reviseMatch, applyPlaylist, reviewResults, localStatus, matchAppleMusic, resolveManualMatch } from "../src/pipeline.js";
import { acquireApplyLock, checkpointTarget } from "../src/apply-lock.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "melon-revise-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = resolveConfig({ root });
  config.applyLockDir = path.join(root, "locks");
  await mkdir(config.dataDir, { recursive: true });
  const songs = ["m1", "m2", "m3"].map((id) => ({ melon_song_id: id, title: id, artist: "Artist", album: "Album" }));
  const original = songs.slice(0, 2).map((song, i) => ({ ...song, match_status: "matched", apple_music_song_id: String(i+1),
    apple_music_title: song.title, apple_music_artist: song.artist, apple_music_album: song.album,
    candidates: [{ id: String(i+1), title: song.title, artist: song.artist, album: song.album }] }));
  const manual = [{ ...songs[2], apple_music_song_id: "3", match_status: "manual_confirmed", match_source: "manual-user-confirmed-itunes-lookup-kr" }];
  for (const [file,doc] of [[config.files.melonLikes,{complete:false,songs}], [config.files.matched,{songs:original}],
    [config.files.unmatched,{songs:[]}], [config.files.manualMatches,{songs:manual}],
    [config.files.importState,{ backend:"web-player",storefront:"kr",added_song_ids:[] }]]) {
    await writeFile(file, JSON.stringify(doc));
  }
  const immutableFiles = [config.files.melonLikes,config.files.matched,config.files.unmatched,config.files.manualMatches,config.files.importState];
  const baseline = await Promise.all(immutableFiles.map((f)=>readFile(f,"utf8")));
  const unchanged = async () => assert.deepEqual(await Promise.all(immutableFiles.map((f)=>readFile(f,"utf8"))),baseline);
  const lookupClient = { async lookupSongs(ids,options) {
    assert.equal(options.sourceStorefront,"kr");
    return ids.map(id=>({id,title:"Corrected",artist:"Artist",album:"Album",url:`https://music.apple.com/kr/song/${id}`}));
  } };
  return { config,songs,unchanged,lookupClient };
}

async function confirm(config, options) {
  const preview = await reviseMatch(config,options);
  return reviseMatch(config,{...options,confirm:true,expectedPreview:preview.preview_hash});
}

function adapter() {
  const tracks = new Set(),calls=[];
  return { backend:"web-player",calls,
    async validateSession(){return {storefront:"kr"};},
    async validateCatalogSongs(ids){calls.push([...ids]);return ids.map(id=>({id}));},
    async createLibraryPlaylist(){return {id:"p.test"};},
    async getLibraryPlaylist(){return {id:"p.test",canEdit:true};},
    async getPlaylistTracks(){return [...tracks].map(id=>({catalog_id:id}));},
    async addTracks(_playlist,ids){calls.push([...ids]);ids.forEach(id=>tracks.add(id));}
  };
}

test("legacy records without Melon IDs retain every selected Apple ID", async t => {
  const { config } = await fixture(t);
  await rm(config.files.melonLikes);
  await writeFile(config.files.matched, JSON.stringify({ songs: ["10", "11"].map(id => ({
    apple_music_song_id: id, match_status: "matched"
  })) }));
  const selection = await readMatchSelection(config);
  assert.deepEqual(selection.selected.map(record => record.apple_music_song_id), ["10", "11", "3"]);
  assert.deepEqual((await applyPlaylist(config, { backend: "web-player", maxAdd: 3 })).selected_add_song_ids, ["10", "11", "3"]);
});

test("hold preview is offline, creates no journal/review/run state, and confirmation requires the exact preview",async t=>{
  const {config,unchanged}=await fixture(t);
  const options={melonSongId:"m1",hold:true,reason:"Different guest"};
  const preview=await reviseMatch(config,options);
  assert.equal(preview.saved,false);assert.equal(preview.before.apple_music_song_id,"1");
  assert.equal(preview.after.match_status,"held");assert.equal(preview.apply_eligible_after,false);
  assert.match(preview.preview_hash,/^[a-f0-9]{64}$/);
  for(const file of [config.files.matchDecisions,config.files.reviewCsv,config.files.reviewRun])await assert.rejects(access(file));
  await assert.rejects(reviseMatch(config,{...options,confirm:true}),/expected-preview/);
  await assert.rejects(reviseMatch(config,{...options,confirm:true,expectedPreview:"0".repeat(64)}),/새 미리보기/);
  await unchanged();await assert.rejects(access(config.files.matchDecisions));
});

test("confirmed hold stays outside status/dry-run/check/execute selection and survives forced matching",async t=>{
  const {config,unchanged,songs}=await fixture(t);
  const saved=await confirm(config,{melonSongId:"m1",hold:true,reason:"Guest differs"});
  assert.equal(saved.saved,true);assert.equal(saved.review.held,1);assert.equal(saved.review_updated,true);
  await unchanged();
  let status=await localStatus(config);
  assert.equal(status.matching.held,1);assert.equal(status.matching.automatic_matched,1);
  assert.equal(status.matching.manual_confirmed,1);assert.equal(status.apply.pending,2);
  assert.equal(status.operations.review.status,"completed");
  assert.match(await readFile(config.files.reviewCsv,"utf8"),/user_hold/);
  const dry=await applyPlaylist(config,{backend:"web-player",maxAdd:1});assert.deepEqual(dry.selected_add_song_ids,["2"]);
  const fake=adapter();
  const checked=await applyPlaylist(config,{backend:"web-player",check:true,maxAdd:1,writeAdapter:fake});
  assert.deepEqual(checked.selected_add_song_ids,["2"]);assert.deepEqual(fake.calls,[["2","3"]]);
  await unchanged();
  await matchAppleMusic(config,{force:true,lookupClient:{async searchSongs(query){
    const song=songs.find(s=>query.includes(s.title));return [{...song,id:song.melon_song_id.slice(1)}];
  }}});
  status=await localStatus(config);assert.equal(status.matching.held,1);assert.equal(status.matching.manual_confirmed,1);
  const resumed=await matchAppleMusic(config,{lookupClient:{async searchSongs(){assert.fail("no-op searched");}}});
  assert.equal(resumed.matched,status.matching.automatic_matched);assert.equal(resumed.manual_confirmed,1);assert.equal(resumed.held,1);
  assert.equal(resumed.searched,0);assert.equal(resumed.reused,songs.length);
  const applied=await applyPlaylist(config,{backend:"web-player",execute:true,maxAdd:1,writeAdapter:fake});
  assert.deepEqual(applied.selected_add_song_ids,["2"]);
  assert(fake.calls.every(ids=>!ids.includes("1")));
});

test("replacement is KR-verified, preserves original files, and retains before/after history when later held or restored",async t=>{
  const {config,unchanged,lookupClient}=await fixture(t);
  await confirm(config,{melonSongId:"m1",appleSongId:"9",reason:"Correct guest",lookupClient});
  await unchanged();
  let status=await localStatus(config);
  assert.equal(status.matching.automatic_matched,1);assert.equal(status.matching.manual_confirmed,2);assert.equal(status.matching.revised,1);
  assert.deepEqual((await applyPlaylist(config,{backend:"web-player",maxAdd:1})).selected_add_song_ids,["9"]);
  await confirm(config,{melonSongId:"m1",hold:true,reason:"Recheck edition"});
  const held=(await readMatchSelection(config)).effective.get("m1");
  assert.equal(held.apple_music_song_id,"9"); // Hold retains the last selected candidate as review evidence.
  assert.equal(held.match_status,"held");
  await confirm(config,{melonSongId:"m1",appleSongId:"9",reason:"Edition confirmed",lookupClient});
  const journal=JSON.parse(await readFile(config.files.matchDecisions));
  assert.deepEqual(journal.decisions.map(d=>d.action),["replace","hold","replace"]);
  assert.equal(journal.decisions[0].before.apple_music_song_id,"1");assert.equal(journal.decisions[0].replacement.apple_music_song_id,"9");
  assert.equal(journal.decisions[1].before.apple_music_song_id,"9");
  assert.equal(journal.decisions[2].previous_revision,journal.decisions[1].revision_id);
  await unchanged();
});

test("replacement rejects duplicate selected IDs, unavailable KR candidates, and non-KR lookup before saving",async t=>{
  const {config,lookupClient,unchanged}=await fixture(t);
  for(const appleSongId of ["2","3"]){
    await assert.rejects(reviseMatch(config,{melonSongId:"m1",appleSongId,reason:"Check",lookupClient}),/이미 연결/);
  }
  await assert.rejects(reviseMatch(config,{melonSongId:"m1",appleSongId:"9",reason:"Check",lookupClient:{async lookupSongs(){return [];}}}),/lookup/);
  await assert.rejects(reviseMatch({...config,storefront:"us"},{melonSongId:"m1",appleSongId:"9",reason:"Check",lookupClient:{async lookupSongs(){throw Error("must not call");}}}),/KR storefront/);
  await unchanged();await assert.rejects(access(config.files.matchDecisions));
});

test("previous manual approvals and checkpointed songs cannot be revised",async t=>{
  const {config}=await fixture(t);
  await assert.rejects(reviseMatch(config,{melonSongId:"m3",hold:true,reason:"Check"}),/기존 수동 승인/);
  const state=JSON.stringify({backend:"web-player",storefront:"kr",added_song_ids:["1"]});
  await writeFile(config.files.importState,state);
  await assert.rejects(reviseMatch(config,{melonSongId:"m1",hold:true,reason:"Check"}),/이미 Apple에 적용/);
  assert.equal(await readFile(config.files.importState,"utf8"),state);
  await assert.rejects(access(config.files.matchDecisions));
});

test("approval becomes invalid after local inputs, other decisions, or candidate metadata change",async t=>{
  const {config,lookupClient}=await fixture(t);
  const opts={melonSongId:"m1",appleSongId:"9",reason:"Correct",lookupClient};
  const preview=await reviseMatch(config,opts);
  await assert.rejects(reviseMatch(config,{...opts,confirm:true,expectedPreview:preview.preview_hash,
    lookupClient:{async lookupSongs(){return [{id:"9",title:"Changed",artist:"Artist",album:"Album"}];}}}),/새 미리보기/);
  await confirm(config,{melonSongId:"m2",hold:true,reason:"Another review"});
  await assert.rejects(reviseMatch(config,{...opts,confirm:true,expectedPreview:preview.preview_hash}),/새 미리보기/);
  const next=await reviseMatch(config,opts);
  await writeFile(config.files.importState,JSON.stringify({backend:"web-player",storefront:"kr",added_song_ids:["99"]}));
  await assert.rejects(reviseMatch(config,{...opts,confirm:true,expectedPreview:next.preview_hash}),/새 미리보기/);
  assert.equal(JSON.parse(await readFile(config.files.matchDecisions)).decisions.length,1);
});

test("changed source invalidates a replacement into a hold, never reviving the automatic candidate",async t=>{
  const {config,songs,lookupClient}=await fixture(t);
  await confirm(config,{melonSongId:"m1",appleSongId:"9",reason:"Correct",lookupClient});
  songs[0].title="Different version";await writeFile(config.files.melonLikes,JSON.stringify({songs}));
  const status=await localStatus(config);
  assert.equal(status.matching.stale_decisions,1);assert.equal(status.matching.held,1);assert.equal(status.matching.revised,0);
  const dry=await applyPlaylist(config,{backend:"web-player",maxAdd:2});assert.deepEqual(dry.selected_add_song_ids,["2","3"]);
  await reviewResults(config);assert.match(await readFile(config.files.reviewCsv,"utf8"),/source_changed_since_confirmation/);
});

test("malformed journals and missing source fail closed for every consumer",async t=>{
  const {config}=await fixture(t);
  await writeFile(config.files.matchDecisions,JSON.stringify({schema_version:1,decisions:[{action:"unknown"}]}));
  for(const fn of [()=>localStatus(config),()=>reviewResults(config),()=>applyPlaylist(config,{backend:"web-player"})])await assert.rejects(fn,/기록이 잘못/);
  await writeFile(config.files.matchDecisions,JSON.stringify({schema_version:999,decisions:[]}));
  await assert.rejects(readMatchSelection(config),/형식/);
  await rm(config.files.matchDecisions);await confirm(config,{melonSongId:"m1",hold:true,reason:"Check"});
  await rm(config.files.melonLikes);await assert.rejects(applyPlaylist(config,{backend:"web-player"}),/원본 Melon 목록/);
});

test("decision approval and execute share locks; dry preview never acquires or overrides a lock",async t=>{
  const {config,unchanged}=await fixture(t);
  const opts={melonSongId:"m1",hold:true,reason:"Check"};
  const preview=await reviseMatch(config,opts);
  const lock=await acquireApplyLock(await checkpointTarget(config.files.matchDecisions),config.applyLockDir);
  try{
    assert.equal((await reviseMatch(config,opts)).saved,false);
    await assert.rejects(reviseMatch(config,{...opts,confirm:true,expectedPreview:preview.preview_hash}),/잠금|실행/);
    await assert.rejects(applyPlaylist(config,{backend:"web-player",execute:true,writeAdapter:adapter()}),/잠금|실행/);
    await unchanged();await assert.rejects(access(config.files.matchDecisions));
  }finally{await lock.release();}
  await confirm(config,opts);
});

test("resolve cannot bypass holds or collide with a replacement",async t=>{
  const {config,lookupClient,songs}=await fixture(t);
  await confirm(config,{melonSongId:"m1",appleSongId:"9",reason:"Correct",lookupClient});
  await assert.rejects(resolveManualMatch(config,{melonSongId:"m1",appleSongId:"8",lookupClient}),/revise/);
  await writeFile(config.files.unmatched,JSON.stringify({songs:[{...songs[2],melon_song_id:"m4",match_status:"ambiguous"}]}));
  await writeFile(config.files.melonLikes,JSON.stringify({songs:[...songs,{...songs[2],melon_song_id:"m4"}]}));
  await assert.rejects(resolveManualMatch(config,{melonSongId:"m4",appleSongId:"9",lookupClient}),/다른 Melon/);
});

test("saved decisions are reported accurately if subsequent review export fails",async t=>{
  const {config}=await fixture(t);
  const bad={...config,files:{...config.files,reviewCsv:config.dataDir}};
  const saved=await confirm(bad,{melonSongId:"m1",hold:true,reason:"Check"});
  assert.equal(saved.saved,true);assert.equal(saved.review_updated,false);assert.equal(saved.next_command,"review");
  assert.equal((await localStatus(config)).matching.held,1);
});

test("reason and mutually exclusive flags are required before any lookup",async t=>{
  const {config}=await fixture(t);
  await assert.rejects(reviseMatch(config,{melonSongId:"m1",hold:true}),/reason/);
  await assert.rejects(reviseMatch(config,{melonSongId:"m1",hold:true,reason:" ".repeat(2)}),/reason/);
  await assert.rejects(reviseMatch(config,{melonSongId:"m1",hold:true,reason:"r".repeat(501)}),/reason/);
  await assert.rejects(reviseMatch(config,{melonSongId:"m1",hold:true,appleSongId:"9",reason:"Check"}),/함께/);
  await assert.rejects(reviseMatch(config,{melonSongId:"m1",hold:true,reason:"Check",expectedPreview:"x"}),/confirm/);
});
