import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { TESTED_VERSIONS, compareVersions, versionWarning } from "../src/version.ts"

describe("compareVersions", () => {
  it("compares major.minor.patch numerically", () => {
    assert.equal(compareVersions("2.0.19", "2.0.19"), 0)
    assert.ok(compareVersions("2.0.20", "2.0.19") > 0)
    assert.ok(compareVersions("2.0.19", "2.1.0") < 0)
    assert.ok(compareVersions("10.0.0", "9.9.9") > 0)
  })

  it("ignores -prerelease and +build suffixes", () => {
    assert.equal(compareVersions("2.0.19-beta.1", "2.0.19"), 0)
    assert.equal(compareVersions("2.0.19+build.5", "2.0.19"), 0)
  })
})

describe("versionWarning", () => {
  it("is quiet inside the tested range, including its bounds", () => {
    assert.equal(versionWarning(TESTED_VERSIONS.min), undefined)
    assert.equal(versionWarning("2.0.99"), undefined)
    assert.equal(versionWarning("2.0.19-beta"), undefined)
  })

  it("warns below min and at/above below", () => {
    const low = versionWarning("2.0.18")
    assert.ok(low?.includes(">=2.0.19 <2.1.0"))
    assert.ok(low?.includes("2.0.18"))
    const high = versionWarning("2.1.0")
    assert.ok(high?.includes("2.1.0"))
    assert.ok(high?.includes("plugin API"))
  })

  it("warns about an unknown version when missing or unparsable", () => {
    assert.ok(versionWarning(undefined)?.includes("unknown version"))
    const garbage = versionWarning("not-a-version")
    assert.ok(garbage?.includes("unknown version"))
    assert.ok(garbage?.includes("not-a-version"))
  })
})
