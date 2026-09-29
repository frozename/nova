# @novaproto/exec-primitives

Execution primitives for hosts that run agent processes:
process-group supervision (`superviseProcess`, `runProcess`), stdio ACP transport
(`StdioAcpClient`, `startStdioAcpServer`), permission request handling
(`StdioAcpPermissionContext`, `handleStdioAcpPermissionRequest`), a warm-process
pool (`createAcpWarmPool`, `poolKeyFor` — hosts compute `spec.specHash`), and ACP session bootstrap
(`initializeAcpSession`).

## Install

```sh
npm install @novaproto/exec-primitives
# or
bun add @novaproto/exec-primitives
```

The package is ESM (`"type": "module"`) with no runtime dependencies. It ships
compiled JavaScript and type declarations under `dist/src`, and imports only
`node:` built-ins, so it runs under Node and Bun alike.

## Host contract

Every input that shapes execution is host-supplied and fail-closed:

- `env` reaches `spawn` verbatim. The library never merges, inherits, or reads
  the parent environment. A missing `env` throws `HostInputError` before spawn.
- `cwd` is required. The library never defaults to the parent working directory.
- `cancelGraceMs` is required on the supervisor, the conveniences, and
  `startStdioAcpServer`. `watchdogMs` is required on the supervisor and the
  conveniences. No library default exists for either.
- `clientInfo` for `initializeAcpSession` is host-supplied and placed on the
  wire verbatim. There is no built-in client identity.
- `poolKeyFor` requires a non-empty host `credentialScope` digest; entries under
  different scopes never share.
- Warm pooling is **not** session resume: the pool holds a live process plus an
  initialized transport. Each consumer issues its own `session/new`.
- No retry, fallback, takeover, or cross-process state exists in the library,
  except the single `session/new` retry after a successful `authenticate`.

Logging is optional and injected (`logger: { debug?, warn?, error? }`). Without
one, the library writes nothing to stdio or console.

## Development

From the repository root, after `bun install`:

```sh
cd packages/exec-primitives
bun run typecheck   # src, tests and scripts
bun test
bun run build       # tsc --build -> dist/src
```

Test titles carry bracketed identifiers such as `[B3]` or `[L6]`. They are
stable ids for the host-boundary contracts the suite pins (environment
boundary, cancel grace, pool keys, single runtime owner), so a failing title
can be traced to the contract it guards across releases.

## Releasing

Releases are tag-driven. `.github/workflows/release-exec-primitives.yml` runs
only when a tag named `exec-primitives-v<version>` is pushed, and releases only
this package. Its `build` job has read-only permissions and no credentials: it
refuses a tag whose version is not plain `X.Y.Z`, runs
`scripts/release-check.ts` (the tag version must equal the manifest
`version`, `private` must be absent, `publishConfig.access` must be `public`),
installs with the frozen lockfile, typechecks, tests, builds and packs
`exec-primitives.tgz`. Its `publish` job waits for approval on the
`npm-release` environment, then stages that exact tarball with
`npm stage publish` through npm trusted publishing (OIDC). No npm token is used;
the job refuses to run if one is configured. A staged version goes live only
after a maintainer approves it with two-factor authentication on npmjs.com.

### One-time setup (before the first tag push)

- Create the `npm-release` environment with a required reviewer, deployment
  tags limited to `exec-primitives-v*`, and admin bypass off. A workflow that
  names a missing environment creates it without protection rules.
- Add a tag ruleset targeting `exec-primitives-v*` with Restrict creations,
  Restrict updates and Restrict deletions, and the release maintainer (or the
  Repository admin role) on its bypass list, so only they can create release
  tags.

### Every release

1. In a release commit, set `version` in `package.json`. For the first release,
   also remove the `"private": true` field, a guard against accidental
   publishes. Merge the commit to `main`.
2. Tag the merged commit and push the tag:

   ```sh
   git tag exec-primitives-v<version> <merged-release-commit>
   git push origin exec-primitives-v<version>
   ```

3. Approve the `publish` job on the `npm-release` environment only if the run
   is for the release commit you merged and the tag you pushed.
4. Approve the staged version on npmjs.com with two-factor authentication only
   if its name, version and file list match that tag. Reject anything you did
   not tag.

For 0.1.0, follow "First release (0.1.0)" below instead of steps 3 and 4.

Pre-releases and backports are not supported as-is. `npm stage publish`
refuses a pre-release, or a version below the highest published version that
is neither a pre-release nor deprecated, without an explicit `--tag`. The
workflow passes none and the tarball check rejects `publishConfig.tag`. A
pre-release tag (not plain `X.Y.Z`) is refused by the `build` job, before the
approval gate; a backport passes the gate and npm normally refuses it at the
stage step (a client-side check; reject it on npmjs.com if it is ever staged). Either
needs a commit that adds `--tag <dist-tag>` to the workflow's
`npm stage publish` line (and, for a pre-release, relaxes its two `X.Y.Z`
checks) before that commit is tagged. The trusted publisher binds only the
workflow filename, so this edit keeps it valid.

### First release (0.1.0)

A trusted publisher can only be attached to a package that already exists, so
0.1.0 is published once by hand, without provenance:

1. Push `exec-primitives-v0.1.0`, let the `build` job finish, and reject the
   `publish` job at the environment gate.
2. With an npm account that can publish under the `@novaproto` scope and has
   two-factor authentication set to authorization and writes, on a maintainer
   machine, in an empty directory (not this package folder,
   where a stale locally packed tarball could be published instead), download
   the `exec-primitives-tarball` artifact from that run (kept for 7 days),
   confirm its sha256 matches the line printed by the `build` job's "Pack and
   confirm the entry point is in the tarball" step, and publish it with a
   session-only web login. No npm token of any kind may be used, including a
   granular token that bypasses two-factor authentication. npm's environment
   config outranks the user config, so a token in any `npm_config_*` variable
   would override the login; stop at any check that fails:

   ```sh
   cd "$(mktemp -d)"
   gh run download <run-id> -R frozename/nova -n exec-primitives-tarball
   sha256sum exec-primitives.tgz   # macOS: shasum -a 256 exec-primitives.tgz
   env | grep -i '^npm_config_'                  # must print nothing
   export NPM_CONFIG_USERCONFIG="$(mktemp)"
   npm config list | grep -E '_auth|_password'   # must print nothing
   npm login --auth-type=web
   npm config list   # exactly one _authToken, under the "user" config
                     # from $NPM_CONFIG_USERCONFIG; nothing "overridden"
   npm whoami
   npm profile get "two-factor auth"   # must print auth-and-writes
   npm publish ./exec-primitives.tgz --access public --dry-run
   npm publish ./exec-primitives.tgz --access public
   npm logout; rm "$NPM_CONFIG_USERCONFIG"; unset NPM_CONFIG_USERCONFIG
   ```

   The real `npm publish` must still stop for a two-factor challenge; if it
   does not, a token was used and must be revoked. A browser download of the
   artifact arrives as `exec-primitives-tarball.zip`; unzip it first.

3. On npmjs.com, add a trusted publisher to the package: organization or user
   `frozename`, repository `nova`, workflow filename
   `release-exec-primitives.yml`, environment `npm-release`, stage-only. The
   fields are case-sensitive and not validated on save. Then set "Require
   two-factor authentication and disallow tokens".

A published version number can never be reused on npm, even after an unpublish.
