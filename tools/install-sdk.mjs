#!/usr/bin/env node
/**
 * Bootstrap the minimal Android SDK needed to *build* an APK without Gradle.
 *
 * Only three packages are required to compile, dex, package and sign an app
 * against the framework:
 *
 *   platforms;android-35    → android.jar to compile against
 *   build-tools;35.x        → aapt2, d8, zipalign, apksigner
 *   platform-tools          → adb
 *
 * Deliberately **not** the full `cmdline-tools` bundle: sdkmanager would pull
 * Gradle-era machinery this project does not use, needs licence acceptance, and
 * is sensitive to the JDK version.  Fetching the platform archives directly from
 * the repository manifest is deterministic, resumable and ~120 MB in total.
 *
 *   node tools/install-sdk.mjs                       # → E:\code\android-sdk
 *   node tools/install-sdk.mjs --dir D:\android-sdk --api 35
 *   node tools/install-sdk.mjs --check               # verify only, no download
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const MANIFEST = 'https://dl.google.com/android/repository/repository2-3.xml'
const BASE = 'https://dl.google.com/android/repository/'

function flag(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? true) : fallback
}

const API = Number(flag('api', 35))
const SDK_DIR = path.resolve(String(flag('dir', 'E:\\code\\android-sdk')))
const CHECK_ONLY = process.argv.includes('--check')

/** Parse `<remotePackage path="...">` blocks with their per-OS archives. */
function extractPackages(source) {
  const packages = []
  const re = /<remotePackage\s+path="([^"]+)"[^>]*>([\s\S]*?)<\/remotePackage>/g
  let match
  while ((match = re.exec(source)) !== null) {
    const [, pkgPath, body] = match
    const archives = []
    const archRe = /<archive>([\s\S]*?)<\/archive>/g
    let arch
    while ((arch = archRe.exec(body)) !== null) {
      const block = arch[1]
      const hostOs = /<host-os>([^<]+)<\/host-os>/.exec(block)?.[1] ?? 'any'
      const url = /<url>([^<]+)<\/url>/.exec(block)?.[1]
      const size = Number(/<size>(\d+)<\/size>/.exec(block)?.[1] ?? 0)
      if (url) archives.push({ hostOs, url, size })
    }
    packages.push({ path: pkgPath, archives })
  }
  return packages
}

function pickArchive(entry) {
  return entry.archives.find((a) => a.hostOs === 'windows') ?? entry.archives.find((a) => a.hostOs === 'any')
}

async function resolvePackages() {
  const response = await fetch(MANIFEST)
  if (!response.ok) throw new Error(`无法获取 SDK 清单: HTTP ${response.status}`)
  const packages = extractPackages(await response.text())

  const platforms = packages
    .filter((p) => /^platforms;android-\d+$/.test(p.path))
    .map((p) => ({ ...p, api: Number(/android-(\d+)$/.exec(p.path)[1]) }))
  const platform =
    platforms.find((p) => p.api === API) ??
    platforms.filter((p) => p.api <= API).sort((a, b) => b.api - a.api)[0]
  if (!platform) throw new Error(`找不到 platforms;android-${API}`)

  const buildTools = packages
    .filter((p) => /^build-tools;\d+\.\d+\.\d+$/.test(p.path))
    .map((p) => {
      const [major, minor, patch] = p.path.split(';')[1].split('.').map(Number)
      return { ...p, major, minor, patch }
    })
  const chosen =
    buildTools.filter((b) => b.major === platform.api).sort((a, b) => b.minor - a.minor || b.patch - a.patch)[0] ??
    buildTools.sort((a, b) => b.major - a.major || b.minor - a.minor)[0]

  const platformTools = packages.find((p) => p.path === 'platform-tools')

  return [
    { kind: 'platform', entry: platform, destDir: path.join(SDK_DIR, 'platforms', `android-${platform.api}`) },
    {
      kind: 'build-tools',
      entry: chosen,
      destDir: path.join(SDK_DIR, 'build-tools', chosen.path.split(';')[1]),
    },
    { kind: 'platform-tools', entry: platformTools, destDir: path.join(SDK_DIR, 'platform-tools') },
  ].map((item) => ({ ...item, archive: pickArchive(item.entry) }))
}

async function download(url, target) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`下载失败 ${url}: HTTP ${response.status}`)
  const total = Number(response.headers.get('content-length') ?? 0)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const handle = fs.createWriteStream(target)
  let received = 0
  let lastPrinted = 0
  const body = Readable.fromWeb(response.body)
  body.on('data', (chunk) => {
    received += chunk.length
    const now = Date.now()
    if (now - lastPrinted > 400) {
      lastPrinted = now
      const pct = total ? ` (${((received / total) * 100).toFixed(0)}%)` : ''
      process.stdout.write(`\r  ${(received / 1048576).toFixed(1)} MB${pct}   `)
    }
  })
  await pipeline(body, handle)
  process.stdout.write(`\r  ${(received / 1048576).toFixed(1)} MB 完成\n`)
  return received
}

/** Extract a zip with .NET, which is far faster than Expand-Archive for thousands of entries. */
function unzip(zipPath, destDir) {
  const script = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$zip = [System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}')`,
    `try { [System.IO.Compression.ZipFileExtensions]::ExtractToDirectory($zip, '${destDir.replace(/'/g, "''")}') } finally { $zip.Dispose() }`,
  ].join('; ')
  return new Promise((resolve, reject) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`解压失败 (${code}): ${stderr.trim()}`)),
    )
    child.on('error', reject)
  })
}

/**
 * Collapse a single wrapping directory.
 *
 * Google's platform/build-tools archives contain one top-level folder
 * (`android-35/`, `android-15/`) while platform-tools contains a folder named
 * after the package itself.  The SDK layout tools expect is flat, so hoist the
 * children and drop the wrapper.
 */
function flattenSingleDirectory(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  const visible = entries.filter((e) => e.name !== '.installed')
  if (visible.length !== 1 || !visible[0].isDirectory()) return false
  const wrapper = path.join(dir, visible[0].name)
  for (const child of fs.readdirSync(wrapper, { withFileTypes: true })) {
    const from = path.join(wrapper, child.name)
    const to = path.join(dir, child.name)
    if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true })
    fs.renameSync(from, to)
  }
  fs.rmSync(wrapper, { recursive: true, force: true })
  return true
}

function verify(items) {
  const checks = [
    { label: 'android.jar', file: path.join(items.platform.destDir, 'android.jar') },
    { label: 'aapt2', file: path.join(items['build-tools'].destDir, 'aapt2.exe') },
    { label: 'd8', file: path.join(items['build-tools'].destDir, 'd8.bat') },
    { label: 'zipalign', file: path.join(items['build-tools'].destDir, 'zipalign.exe') },
    { label: 'apksigner', file: path.join(items['build-tools'].destDir, 'apksigner.bat') },
    { label: 'adb', file: path.join(items['platform-tools'].destDir, 'adb.exe') },
  ]
  for (const check of checks) {
    console.log(`${fs.existsSync(check.file) ? '✓' : '✗'} ${check.label.padEnd(12)} ${check.file}`)
  }
  return checks.every((c) => fs.existsSync(c.file))
}

const items = await resolvePackages()
const byKind = Object.fromEntries(items.map((i) => [i.kind, i]))

console.log(`SDK 目录: ${SDK_DIR}`)
for (const item of items) {
  console.log(`  ${item.kind.padEnd(14)} ${item.entry.path}  (${(item.archive.size / 1048576).toFixed(1)} MB)`)
}
console.log('')

if (!CHECK_ONLY) {
  const cache = path.join(SDK_DIR, '.downloads')
  for (const item of items) {
    const marker = path.join(item.destDir, '.installed')
    if (fs.existsSync(marker)) {
      console.log(`- ${item.kind}: 已安装，跳过`)
      continue
    }
    console.log(`- ${item.kind}: 下载 ${item.archive.url}`)
    const zipPath = path.join(cache, item.archive.url)
    const existing = fs.existsSync(zipPath) ? fs.statSync(zipPath).size : 0
    if (existing !== item.archive.size) {
      await download(BASE + item.archive.url, zipPath)
    } else {
      console.log('  使用已有缓存')
    }
    console.log(`- ${item.kind}: 解压到 ${item.destDir}`)
    fs.mkdirSync(item.destDir, { recursive: true })
    await unzip(zipPath, item.destDir)
    if (flattenSingleDirectory(item.destDir)) {
      console.log(`  （已展开顶层目录）`)
    }
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`)
  }
  console.log('')
}

const ok = verify(byKind)
if (!ok) {
  console.error('\nSDK 组件不完整。')
  process.exit(1)
}
console.log('\nSDK 就绪。把它写进 config.json 或设置 ANDROID_HOME:')
console.log(`  ANDROID_HOME=${SDK_DIR}`)
