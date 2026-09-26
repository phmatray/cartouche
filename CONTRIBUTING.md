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

Every release:

1. Wait until CI is green on `main`. The Pages workflow deploys `main` only
   after CI succeeded on that commit.
2. Add a `## [1.2.3] - <date>` entry to `CHANGELOG.md` (the Release workflow
   fails without one).
3. Tag the commit (`git tag v1.2.3 && git push origin v1.2.3`). The Release
   workflow runs the whole CI again on the tag, then builds the zip and
   publishes the GitHub release with the CHANGELOG entry as notes.

Only publish artifacts built by the workflows. A local build can contain
paths from your machine, and is not what CI tested.

## Conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
