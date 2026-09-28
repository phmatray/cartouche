# Contributing to Cartouche

Thanks for helping. Please read this page before opening an issue or a pull
request.

## The one hard rule: no copyrighted game material

Never add, attach, paste or link to:

- ROMs of commercial games (`.gb`, `.gbc`, `.sgb`, archives containing them);
- BIOS or boot ROM dumps, or code copied or translated from them;
- box art, manuals, screenshots or other artwork of commercial games,
  Nintendo logos or other Nintendo artwork;
- sites or torrents where such files can be downloaded.

This applies to code, tests, issues, pull requests, discussions and commit
history. Such content is removed without discussion. If you need a game to
reproduce a bug, name it (title, region, revision and the SHA-1 of your own
dump) instead of sharing it.

Homebrew is welcome in the catalog only if its license clearly allows it and
you record the author, year, license and official page. A homebrew ROM may be
bundled only if its license allows redistribution; add it to
`THIRD_PARTY_NOTICES.md` and to the `.gitignore` allow-list in the same PR.

The emulator must stay a clean implementation based on public documentation
(Pan Docs, test ROM sources, hardware research). Do not look at or copy
leaked or disassembled Nintendo code.

## Development

See the README for building. Before sending a PR:

```bash
./scripts/fetch-test-roms.sh                 # test ROMs and homebrew, git-ignored
cd gb-core && cargo test --release --no-fail-fast
cd ../gb-web && npm run lint && npm run build
```

Screenshots from `cargo run --example render` go in `screenshots/`
(git-ignored); never commit screenshots of commercial games.

Do not skip, ignore or special-case a test to make it pass, and never detect
test ROMs by title or checksum. Fix the emulator.

`gb-core/tests/expected-failures.txt` is a record, not a skip. Every conformance
ROM it lists still runs on every CI run, and the test asserts that it fails: CI
turns red when a listed ROM starts passing, and tells you which line to remove.
Remove a line only in the change that makes its ROM pass. Add lines only when a
new suite is added, never to hide a regression.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `docs:`, `chore:`...).
- Keep PRs focused, and fill in the pull request template checklist.
- Optional but appreciated: sign off your commits (`git commit -s`) to certify
  the [Developer Certificate of Origin](https://developercertificate.org/),
  that is, that you wrote the change or have the right to submit it under the
  project's MIT License.

By contributing you agree that your contribution is licensed under the MIT
License of this repository.

## Releasing (maintainers)

One-time repository setup, before the first push to `main`:

- Settings > Pages > Source: **GitHub Actions**
  (`gh api -X POST repos/phmatray/cartouche/pages -f build_type=workflow`);
  without it the Pages workflow fails with "Get Pages site failed".
- Settings > Security: enable **Private vulnerability reporting**, which
  SECURITY.md and the issue template links rely on.

Releases are cut by [release-please](https://github.com/googleapis/release-please)
from the [Conventional Commits](https://www.conventionalcommits.org/) on `main`:

1. Use conventional commit subjects (`feat:`, `fix:`, `docs:`...). `feat`
   bumps the minor version, `fix` the patch, and `!` or `BREAKING CHANGE`
   the major.
2. On every push to `main`, the release-please workflow keeps a release PR
   up to date: it writes the `CHANGELOG.md` entry and bumps the version in
   `gb-web/package.json` and `gb-core/Cargo.toml`.
3. Merge that PR to release. The same workflow tags `vX.Y.Z`, creates the
   GitHub release, runs the whole CI again on the released commit, then
   attaches the web build and µCity's source archive. Don't tag by hand.

The Pages workflow deploys `main` only after CI succeeded on that commit.

Dependencies are kept current by Renovate (shared `phmatray/.github`
preset). Dependabot is not used.

Only publish artifacts built by the workflows. A local build can contain
paths from your machine, and is not what CI tested.

## Conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
