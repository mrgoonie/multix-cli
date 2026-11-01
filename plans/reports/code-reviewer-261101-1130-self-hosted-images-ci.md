# Code review: self-hosted images CI (#562)

Isolated reviewer (did not write the change). Scope: `git diff origin/dev HEAD`
at 2dc75dc: `.github/scripts/check-self-hosted-image.sh`,
`.github/workflows/self-hosted-images.yml`, `.github/workflows/publish-server-image.yml`,
`worker/container/Dockerfile`, the EN/VI self-hosted guides, `README.md`,
`worker/server/server.env.example`, `AGENTS.md`.

## Verdict

Workflow wiring is correct: matrix, `registry` output and `IMAGE` line up;
attestation is per image; `fail-fast: false` with a per-image overwrite guard;
the PR check uses `pull_request` with `contents: read` and no persisted
credentials; path filters cover every `COPY` source of both Dockerfiles; the
job Dockerfile still builds with no build args (Cloudflare); EN/VI parity holds.
The caller in `release-please.yml` already grants `packages: write`,
`id-token: write` and `attestations: write`.

## Findings

| Id | Severity | Finding | Outcome |
|---|---|---|---|
| H1 | High | New GHCR packages are private by default; the Kubernetes runner sets no `imagePullSecrets`, so `ghcr.io/mrgoonie/multix-job:<version>` would not pull until made public. | Owner step documented in the publish workflow header; tracked in a follow-up issue, with `imagePullSecrets` support as a separate issue. |
| M1 | Medium | The overwrite guard treats only "not found / manifest unknown" as absent; its answer for a never-published package is unverified, and the workflow has never run (not on `main`). Fails closed. | Tracked with H1: watch the first run after release. |
| M2 | Medium | Job smoke check ran the container with `--rm`, so a job server that exits at start lost its logs and failed on `docker port` with no message. | Fixed: no `--rm` (trap removes it), guarded `docker port`, logs printed. Verified with an image whose CMD exits 3: the error and its log line are shown, exit 1, no container left. |
| M3 | Medium | README and env example stated the published image with no fallback for releases before it. | Fixed: both say to build `worker/container/Dockerfile` for a release without it. |
| L1 | Low | Job image base `node:22-alpine` floats; server pins `node:22.23.4-alpine`. | Left as is: the same file builds the live Cloudflare container; noted in the PR. |
| L2 | Low | `${{ }}` interpolated into a `run:` line. | Fixed: passed through `env:`. |
| L3 | Low | QEMU now emulates the arm64 build; duration under the 30 min timeout is unverified. | Watch the first publish run (follow-up issue). |
| L4 | Low | Publishing by hand for an older tag always fails the multix-server leg. | Documented in the workflow header. |

## Unresolved

- GHCR's exact answer to `imagetools inspect` for a package that does not yet
  exist, authenticated with `GITHUB_TOKEN` (decides M1).
