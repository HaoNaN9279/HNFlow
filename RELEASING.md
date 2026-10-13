# Releasing DeerFlow

DeerFlow releases are **tag-driven**: pushing a `v*` git tag triggers the
publishing workflows. There is no separate release script that bumps versions —
the maintainer bumps the version sources, commits, and
tags. The helper scripts below keep the version sources in lockstep, and CI
gates the release on them agreeing with the tag.

## Version sources

A release version must appear, identically, in two places:

| File                                   | Field                |
| -------------------------------------- | -------------------- |
| `backend/pyproject.toml`               | `version = "X.Y.Z"`  |
| `frontend/package.json`                | `"version": "X.Y.Z"` |

Plus the git tag `vX.Y.Z` itself, which is the canonical release identifier.

Container images are tagged from the git tag (not from these files), and the
version is validated against the tag — so if any source lags the
tag, the release is blocked (see [Version gate](#version-gate)).

The frontend's in-app About page (Settings ▸ About) is a *derived* consumer, not
a third source: it reads `frontend/package.json`'s version at build time, so it
tracks the table above automatically with no bump needed. Nightly builds override
it with the nightly string (`<base>-nightly.<YYYYMMDD>-<short_sha>`) via
the `APP_VERSION` build-arg in `nightly.yaml`, so a nightly image's About page
distinguishes it from a release.

## Helper scripts

- `scripts/bump_version.sh <version>` — set all fields at once, then
  self-verify. Tolerates a leading `v` (e.g. `v2.1.0`).
  ```bash
  scripts/bump_version.sh 2.1.0
  ```
- `scripts/verify_versions.sh [version]` — check that all sources agree. With
  no argument it requires mutual equality; with an argument it requires every
  source to equal it. Exits non-zero on mismatch. Run it locally before tagging
  to catch drift early:
  ```bash
  scripts/verify_versions.sh 2.1.0
  ```

## Release procedure

1. **Bump the version** across all sources:
   ```bash
   scripts/bump_version.sh 2.1.0
   ```
2. **Record release notes**: `CHANGELOG.md` is no longer maintained in this
   repository; release notes are derived from `git log`. Review the commits
   since the previous tag and include the highlights in the release commit
   message (and later in the GitHub Release notes).
3. **Commit** the version changes:
   ```bash
   git add -A
   git commit -m "release: v2.1.0"
   ```
4. **Tag and push**:
   ```bash
   git tag v2.1.0
   git push origin v2.1.0
   ```
   Pushing the tag triggers the publishing workflows (below).

## What CI publishes on a `v*` tag

- `.github/workflows/container.yaml` — builds and pushes `backend` and
  `frontend` images to `ghcr.io`, tagged with the release version (and `latest`
  on the default branch).

## Nightly builds

`.github/workflows/nightly.yaml` runs on a schedule (and `workflow_dispatch`)
to publish the same two images from unreleased `main`. It is
**not** gated by the version check (there is no `v*` tag) and it does **not**
touch the `latest` tag, which stays pinned to the last `v*` release. Every job
is gated on `github.repository == 'bytedance/deer-flow'` (legacy upstream
constraint), so it only runs on
the upstream repo - a scheduled run or manual dispatch on a fork skips all jobs.

Artifacts (under the running repo's owner, where `<date>` is `YYYYMMDD`):

- Images: `ghcr.io/<owner>/deer-flow-{backend,frontend}:nightly`
  (rolling, overwritten each run) and `:nightly-<date>` (pinned to a day, but
  mutable within it - a same-day re-dispatch overwrites it). For a truly
  immutable pin, use `:sha-<short>`.

## lark-cli sandbox images

The two optional Lark sandbox runtime images — `lark-cli-init` (Pattern A) and
`lark-cli-broker` (Pattern B) — are **not** part of the `v*` release. They track
the upstream `larksuite/cli` version, so they publish independently via
`.github/workflows/lark-cli-images.yaml`:

- Trigger with `workflow_dispatch` (a `lark_cli_version` input, e.g. `v1.0.65`)
  or by pushing a `lark-cli-v*` tag (the version is read from after the prefix).
- Builds multi-arch (`linux/amd64,linux/arm64`) and pushes
  `ghcr.io/<owner>/deer-flow-{lark-cli-init,lark-cli-broker}:<lark-cli-version>`.
- Gated on `github.repository == 'bytedance/deer-flow'` (legacy upstream
  constraint); not tied to the
  `verify-versions` gate (its version is the lark-cli release, not the DeerFlow
  release), and it never touches `latest`.

## Version gate

The publishing workflow calls `.github/workflows/verify-versions.yml` as its
first job. It runs `scripts/verify_versions.sh` against the tag (minus the
`v`). If any version source doesn't match the tag, the verify job
fails and **all** publish jobs are skipped — no images.

When it fails, the job annotation names the offending file and suggests the
fix:

```
::error::frontend/package.json is '2.0.0' but expected '2.1.0'.
Tip: run scripts/bump_version.sh 2.1.0 to align all sources.
```

## Pre-releases (RCs)

Pre-release tags like `v2.1.0-rc1` are valid `v*` tags and trigger the same
workflows. The version sources must equal the full pre-release string
(`2.1.0-rc1`) — the gate compares exact strings. Use the same procedure with
the rc version:

```bash
scripts/bump_version.sh 2.1.0-rc1
# record release notes in the commit, tag v2.1.0-rc1, push
```

## Recovering from a failed gate

If the gate failed because a source was forgotten:

1. Run `scripts/bump_version.sh <version>` to align the sources.
2. Amend or add a follow-up commit.
3. Delete and re-create the tag, then push it:
   ```bash
   git tag -d v2.1.0
   git tag v2.1.0
   git push origin :refs/tags/v2.1.0
   git push origin v2.1.0
   ```

Re-pushing the tag re-triggers the workflows. Because the gate blocks **all**
artifacts when it fails, nothing was published under the bad tag, so re-tagging
is safe — no images were pushed to overwrite.

## Post-release

Optionally draft a **GitHub Release** from the tag. `CHANGELOG.md` is no
longer maintained in this repository; compose the release notes from `git log`
between the tag and the previous one.
