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
only when a tag named `exec-primitives-v<version>` is pushed, and publishes only
this package.

1. One-time: add the repository secret `NPM_TOKEN`, an npm token that can
   publish public packages under the `@novaproto` scope. Without it the publish
   step fails and nothing is released.
2. In a release commit, set `version` in `package.json` and remove the
   `"private": true` field. That field is a guard against accidental publishes
   and stays in place until a release is intended. Merge the commit to `main`.
3. Tag the merged commit and push the tag:

   ```sh
   git tag exec-primitives-v0.1.0 <merged-release-commit>
   git push origin exec-primitives-v0.1.0
   ```

The workflow first runs `scripts/release-check.ts`, which refuses unless the tag
version equals the manifest `version`, `private` is absent, and
`publishConfig.access` is `public`. It then installs with the frozen lockfile,
typechecks, tests, builds, dry-runs the pack, and runs
`bun publish --access public`.

### Manual alternative

From a clean checkout of the merged release commit, with npm credentials for an
account that can publish under `@novaproto` (for example after `npm login`):

```sh
bun install --frozen-lockfile
cd packages/exec-primitives
bun scripts/release-check.ts exec-primitives-v0.1.0
bun run typecheck && bun test
bun publish --dry-run          # expect only dist/src, README.md, LICENSE, package.json
bun publish --access public
```

`bun publish` runs the `prepack` script (`tsc --build`), so the published
`dist/` is always built from the checked-out source. A published version number
can never be reused on npm, even after an unpublish.
