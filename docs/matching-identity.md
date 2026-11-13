# Conservative identity checks

The title core is scored separately from participant identity. All named primary
artists and Feat./Featuring/FT/Vocal/Song By guests are compared one to one.
Punctuation, collaborator separators, explicit Korean/English parenthetical
aliases and saved storefront aliases are supported. Names are not translated or
guessed. Shorter aliases cannot erase canonical participants. A guest listed in
the other catalog's artist field can provide the same participant evidence;
conflicting explicit guest roles on both sides require review.

The existing score threshold (0.88) and minimum margin (0.06) remain unchanged.
Identity reasons prevent automatic matching even with exact ISRC or score 1.
Apple playParams establishes availability, not recording identity.

Explicit English/Korean/Japanese and Guitar/Cello/Band title annotations are
compared. Unmarked titles are not assumed to be a particular language or
arrangement. Prod. credits are not vocal or arrangement identity evidence.

Review reasons are stored in `match_reasons` and exported by the existing review
workflow; detailed evidence is in `match_components`:

| Reason | Meaning |
| --- | --- |
| primary_artist_missing | A primary artist is absent |
| participant_information_missing | Participant counts differ |
| participant_mismatch | Named participants cannot all be reconciled |
| guest_artist_information_missing | Guest evidence is absent on one side |
| guest_artist_mismatch | Named guest evidence cannot be reconciled |
| guest_artist_role_conflict | Same participants have conflicting explicit guest roles |
| alias_participant_count_conflict | An alias changes primary or guest counts |
| language_version_conflict / arrangement_version_conflict | Both titles explicitly indicate different editions |
| language_version_information_missing / arrangement_version_information_missing | Only one title has explicit edition evidence |

These reasons indicate review needs, not confirmed mismatches. Unknown aliases
remain for review. Unrecognized credit or edition syntax is not inferred.
Existing saved decisions are reused as before; integrating this code does not
retroactively replace automatic decisions or approved manual confirmations.

## Offline audit

Run `node scripts/audit-matches.js SOURCE_ROOT FRESH_OUTPUT_DIRECTORY`.
The output directory must be outside the source repository and must not exist.
Only `data/melon_likes.json`, `matched.json`, `unmatched.json`, and
`manual_matches.json` are read. SHA-256 hashes are checked before and after the
audit. No browser, network search, authentication or account write is performed.

`audit.json` includes all audited automatic rows and participant/edition evidence;
`needs-review.csv` includes flagged rows with their previous decisions and reasons;
`summary.json` includes counts and source hashes. Missing saved candidate aliases
or margins are separately flagged. Saved margins are retained, not recomputed
from an incomplete top-five candidate list. The report does not assert that rows
without a new review reason are definitively the same recording.
