import path from "node:path";

export function resolveConfig(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const dataDir = path.resolve(root, options.dataDir ?? "data");
  const stateDir = path.resolve(root, options.stateDir ?? ".state");
  return {
    root,
    dataDir,
    stateDir,
    storefront: (process.env.APPLE_MUSIC_STOREFRONT || "kr").toLowerCase(),
    files: {
      browserConfig: path.join(stateDir, "browser-config.json"),
      extractionRun: path.join(stateDir, "melon-extraction-run.json"),
      matchingRun: path.join(stateDir, "matching-run.json"),
      reviewRun: path.join(stateDir, "review-run.json"),
      melonLikes: path.join(dataDir, "melon_likes.json"),
      matched: path.join(dataDir, "matched.json"),
      unmatched: path.join(dataDir, "unmatched.json"),
      manualMatches: path.join(dataDir, "manual_matches.json"),
      unavailableMatches: path.join(dataDir, "unavailable_matches.json"),
      matchDecisions: path.join(dataDir, "match_decisions.json"),
      existingSongLinks: path.join(dataDir, "existing_song_links.json"),
      songRecoveries: path.join(dataDir, "song_recoveries.json"),
      recoveryFollowups: path.join(dataDir, "recovery_followups.json"),
      recoveryCatalogApprovals: path.join(dataDir, "recovery_catalog_approvals.json"),
      reviewCsv: path.join(dataDir, "review.csv"),
      reviewHtml: path.join(dataDir, "review.html"),
      importState: path.join(dataDir, "apple_import_state.json"),
      musicUserToken: path.join(dataDir, ".apple-music-user-token")
    }
  };
}
