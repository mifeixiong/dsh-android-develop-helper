#!/usr/bin/env node
/**
 * Resolve the current download URLs for the Android SDK packages we need,
 * straight from Google's repository manifest.
 *
 * Using the manifest instead of hard-coded filenames means the build script
 * keeps working when Google revs a package (build-tools_r35 → r35.0.0, etc.).
 *
 *   node tools/sdk-urls.mjs                 # list platform + build-tools candidates
 *   node tools/sdk-urls.mjs --json          # machine-readable
 */
const MANIFEST = 'https://dl.google.com/android/repository/repository2-3.xml'

const apiArg = process.argv.indexOf('--api')
const TARGET_API = apiArg >= 0 ? Number(process.argv[apiArg + 1]) : 35

const response = await fetch(MANIFEST)
if (!response.ok) throw new Error(`manifest fetch failed: HTTP ${response.status}`)
const xml = await response.text()

/** Pull `<remotePackage path="...">…</remotePackage>` blocks with their archive url. */
function extractPackages(source) {
  const packages = []
  const re = /<remotePackage\s+path="([^"]+)"[^>]*>([\s\S]*?)<\/remotePackage>/g
  let match
  while ((match = re.exec(source)) !== null) {
    const path = match[1]
    const body = match[2]
    const revision = /<major>(\d+)<\/major>/.exec(body)?.[1] ?? '0'
    const archives = []
    // Each <archive> block carries its own <host-os> and <url>.
    const archRe = /<archive>([\s\S]*?)<\/archive>/g
    let arch
    while ((arch = archRe.exec(body)) !== null) {
      const block = arch[1]
      const hostOs = /<host-os>([^<]+)<\/host-os>/.exec(block)?.[1] ?? 'any'
      const url = /<url>([^<]+)<\/url>/.exec(block)?.[1]
      const size = Number(/<size>(\d+)<\/size>/.exec(block)?.[1] ?? 0)
      const checksum = /<sha1>([^<]+)<\/sha1>/.exec(block)?.[1] ?? null
      if (url) archives.push({ hostOs, url, size, checksum })
    }
    packages.push({ path, revision: Number(revision), archives })
  }
  return packages
}

const packages = extractPackages(xml)

function withWindowsArchive(predicate) {
  return packages
    .filter(predicate)
    .map((p) => {
      const archive =
        p.archives.find((a) => a.hostOs === 'windows') ?? p.archives.find((a) => a.hostOs === 'any')
      return archive ? { ...p, archive } : null
    })
    .filter(Boolean)
}

const selected = []

// Prefer the exact API level the emulator runs; fall back to the newest below it.
const platforms = withWindowsArchive((p) => /^platforms;android-\d+$/.test(p.path)).map((p) => ({
  ...p,
  api: Number(/android-(\d+)$/.exec(p.path)[1]),
}))
const platform =
  platforms.find((p) => p.api === TARGET_API) ??
  platforms.filter((p) => p.api <= TARGET_API).sort((a, b) => b.api - a.api)[0] ??
  platforms.sort((a, b) => b.api - a.api)[0]
if (platform) selected.push({ kind: 'platform', ...platform })

// Build-tools: prefer the same major version as the platform, else the newest.
const buildTools = withWindowsArchive((p) => /^build-tools;\d+\.\d+\.\d+$/.test(p.path)).map((p) => {
  const [major, minor, patch] = p.path.split(';')[1].split('.').map(Number)
  return { ...p, major, minor, patch }
})
const sameMajor = buildTools
  .filter((b) => b.major === TARGET_API)
  .sort((a, b) => b.minor - a.minor || b.patch - a.patch)[0]
const chosenBuildTools = sameMajor ?? buildTools.sort((a, b) => b.major - a.major || b.minor - a.minor)[0]
if (chosenBuildTools) selected.push({ kind: 'build-tools', ...chosenBuildTools })

const platformTools = withWindowsArchive((p) => p.path === 'platform-tools').sort(
  (a, b) => b.revision - a.revision,
)[0]
if (platformTools) selected.push({ kind: 'platform-tools', ...platformTools })

const cleaned = selected.filter((entry) => entry.archive)

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(selected, null, 2))
} else {
  for (const entry of selected) {
    console.log(`${entry.kind.padEnd(14)} ${entry.path}`)
    console.log(`  url    : https://dl.google.com/android/repository/${entry.archive.url}`)
    console.log(`  size   : ${(entry.archive.size / 1048576).toFixed(1)} MB`)
    console.log(`  sha1   : ${entry.archive.checksum ?? '(none)'}`)
  }
}
