/**
 * Locate the harness packages from a test.
 *
 * The toolkit itself has no dependency on the harness, but validating the tool
 * definitions against the *real* registry contract is worth a test-only import:
 * the profile's hoisted `node_modules` contains `@deepseek-ai/dsh-tools`, so we
 * load it by absolute URL and skip when it is absent.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const CANDIDATE_ROOTS = [
  process.env.DSH_HARNESS_MODULES,
  process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'profiles', 'node_modules') : null,
  process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, 'AppData', 'Local', 'npm-cache', '_npx')
    : null,
].filter(Boolean)

function findPackageDir(packageName) {
  for (const root of CANDIDATE_ROOTS) {
    if (!fs.existsSync(root)) continue
    const direct = path.join(root, ...packageName.split('/'))
    if (fs.existsSync(path.join(direct, 'package.json'))) return direct
    // The npx cache nests one level: <root>/<hash>/node_modules/<pkg>
    let entries = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const nested = path.join(root, entry.name, 'node_modules', ...packageName.split('/'))
      if (fs.existsSync(path.join(nested, 'package.json'))) return nested
    }
  }
  return null
}

/** Import a harness package by absolute path, or return null when unavailable. */
export async function loadHarnessPackage(packageName) {
  const dir = findPackageDir(packageName)
  if (!dir) return null
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const entry = typeof manifest.exports === 'string' ? manifest.exports : manifest.exports?.['.']?.default ?? manifest.main
  const target = path.join(dir, entry ?? 'lib/index.js')
  if (!fs.existsSync(target)) return null
  return import(pathToFileURL(target).href)
}
