/**
 * Release preflight for @novaproto/exec-primitives.
 *
 * Refuses (exit 1) unless the release tag names exactly the manifest version
 * and the manifest is publishable: the expected name, no `private` field, and
 * `publishConfig.access: "public"`. Run by the release workflow before any
 * build or publish step, and usable locally before a manual publish:
 *
 *   bun scripts/release-check.ts exec-primitives-v0.1.0
 *
 * The tag is read from the first argument, else from $RELEASE_TAG.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const PACKAGE_NAME = "@novaproto/exec-primitives";
export const TAG_PREFIX = "exec-primitives-v";

export interface ReleaseManifest {
  name?: unknown;
  version?: unknown;
  private?: unknown;
  publishConfig?: { access?: unknown } | null;
}

/** Every reason the tag/manifest pair must not be published; empty when it may. */
export function releaseProblems(tag: string | undefined, manifest: ReleaseManifest): string[] {
  const problems: string[] = [];
  if (tag === undefined || tag === "") {
    problems.push("no release tag given");
  } else if (!tag.startsWith(TAG_PREFIX) || tag.length === TAG_PREFIX.length) {
    problems.push(`tag "${tag}" does not match ${TAG_PREFIX}<version>`);
  } else if (tag.slice(TAG_PREFIX.length) !== manifest.version) {
    problems.push(
      `tag version "${tag.slice(TAG_PREFIX.length)}" does not equal manifest version "${String(manifest.version)}"`,
    );
  }
  if (manifest.name !== PACKAGE_NAME) {
    problems.push(`manifest name is "${String(manifest.name)}", expected "${PACKAGE_NAME}"`);
  }
  if ("private" in manifest) {
    problems.push('manifest still has a "private" field; the release commit must remove it');
  }
  if (manifest.publishConfig?.access !== "public") {
    problems.push('manifest publishConfig.access must be "public"');
  }
  return problems;
}

if (import.meta.main) {
  const tag = process.argv[2] ?? process.env["RELEASE_TAG"];
  const manifestPath = join(dirname(import.meta.dir), "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ReleaseManifest;
  const problems = releaseProblems(tag, manifest);
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`release-check: ${problem}`);
    }
    process.exit(1);
  }
  console.log(
    `release-check: ok, ${PACKAGE_NAME}@${String(manifest.version)} from tag ${String(tag)}`,
  );
}
