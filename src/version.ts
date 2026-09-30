/**
 * The OpenCode versions this plugin is tested against. Anything outside the
 * range gets a warning — the plugin API is not stable across minor bumps.
 *
 * Pure module: no imports, so it loads under plain Node for tests.
 */
export const TESTED_VERSIONS = { min: "2.0.19", below: "2.1.0" } as const

const parse = (version: string): [number, number, number] | undefined => {
  const core = version.split("-")[0]?.split("+")[0] ?? ""
  const parts = core.split(".").map((part) => (part === "" ? Number.NaN : Number(part)))
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) return undefined
  return parts as [number, number, number]
}

/** Numeric major.minor.patch compare; `-prerelease` and `+build` suffixes are ignored. NaN when either side is unparsable. */
export function compareVersions(a: string, b: string): number {
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) return Number.NaN
  for (let index = 0; index < 3; index += 1) {
    const delta = left[index] - right[index]
    if (delta !== 0) return delta
  }
  return 0
}

/** undefined when `version` is inside the tested range; a warning string otherwise. */
export function versionWarning(version: string | undefined): string | undefined {
  const tested = `OpenCode >=${TESTED_VERSIONS.min} <${TESTED_VERSIONS.below}`
  if (version === undefined || parse(version) === undefined) {
    return `opencode-fusion is tested on ${tested}; this is an unknown version${version ? ` (${version})` : ""}. The plugin API may differ.`
  }
  if (compareVersions(version, TESTED_VERSIONS.min) >= 0 && compareVersions(version, TESTED_VERSIONS.below) < 0) {
    return undefined
  }
  return `opencode-fusion is tested on ${tested}; this is ${version}. The plugin API may differ.`
}
