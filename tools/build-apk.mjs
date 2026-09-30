#!/usr/bin/env node
/**
 * Build, align and sign an APK without Gradle.
 *
 * Why not Gradle: this project's job is to drive an emulator, and a Gradle build
 * would add a JVM-version-sensitive wrapper, a dependency-resolution network
 * round trip, and a daemon to start before any APK exists. The four steps that
 * actually produce an APK are short and completely deterministic:
 *
 *   aapt2 compile   resources → compiled resource archive
 *   aapt2 link      resources + manifest → an APK skeleton (+ the R.java)
 *   javac + d8      Java sources → classes.dex
 *   package + sign  add the dex, align, sign
 *
 * The packaging step uses this repository's own ZIP writer because
 * `resources.arsc` must be *stored* and 4-byte aligned for the platform's mmap
 * path, and no shipped Windows tool guarantees that.
 *
 *   node tools/build-apk.mjs --project examples/dorm-duty --sdk E:\code\android-sdk
 *   node tools/build-apk.mjs --project ... --out build/dorm-duty.apk --verbose
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readZip, writeZip, findMisalignedEntries } from '../src/zip.js'
import { apkSummary } from '../src/apk.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.dirname(HERE)

function flag(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? true) : fallback
}

const PROJECT = path.resolve(String(flag('project', path.join(REPO, 'examples', 'dorm-duty'))))
const SDK = path.resolve(String(flag('sdk', process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? 'E:\\code\\android-sdk')))
const OUT = path.resolve(String(flag('out', path.join(PROJECT, 'build', 'app.apk'))))
const MIN_SDK = Number(flag('min-sdk', 24))
const TARGET_SDK = Number(flag('target-sdk', 35))
const JAVA_RELEASE = Number(flag('java-release', 11))
const VERBOSE = process.argv.includes('--verbose')

const BUILD = path.join(PROJECT, 'build')
const GEN = path.join(BUILD, 'gen')
const CLASSES = path.join(BUILD, 'classes')
const DEX = path.join(BUILD, 'dex')

// ── process helpers ─────────────────────────────────────────────────────────

function run(command, args, options = {}) {
  if (VERBOSE) console.log(`  $ ${command} ${args.join(' ')}`)
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0 || options.allowFailure) resolve({ code, stdout, stderr })
      else reject(new Error(`${command} 退出码 ${code}\n${stdout}\n${stderr}`.trim()))
    })
  })
}

/** Locate the JDK that owns the `java` on PATH; `java.home` is authoritative. */
async function detectJavaHome() {
  if (process.env.JAVA_HOME && fs.existsSync(path.join(process.env.JAVA_HOME, 'bin', 'java.exe'))) {
    return process.env.JAVA_HOME
  }
  const result = await run('java', ['-XshowSettings:properties', '-version'], { allowFailure: true })
  // `-XshowSettings` writes the properties block to stderr, not stdout.
  const match = /java\.home\s*=\s*(.+)/.exec(`${result.stdout}\n${result.stderr}`)
  if (match) return match[1].trim()
  throw new Error('找不到 JDK：请设置 JAVA_HOME')
}

function newestDirectory(dir) {
  if (!fs.existsSync(dir)) return null
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) =>
      b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }),
    )
  return entries.length ? path.join(dir, entries[0]) : null
}

function walk(dir, predicate, found = []) {
  if (!fs.existsSync(dir)) return found
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, predicate, found)
    else if (predicate(full)) found.push(full)
  }
  return found
}

// ── toolchain ───────────────────────────────────────────────────────────────

async function resolveToolchain() {
  const platforms = path.join(SDK, 'platforms')
  const platformDir = newestDirectory(platforms)
  if (!platformDir) throw new Error(`SDK 中没有 platforms 目录: ${platforms}`)
  const androidJar = path.join(platformDir, 'android.jar')
  if (!fs.existsSync(androidJar)) throw new Error(`缺少 ${androidJar}（先运行 tools/install-sdk.mjs）`)

  const buildToolsDir = newestDirectory(path.join(SDK, 'build-tools'))
  if (!buildToolsDir) throw new Error(`SDK 中没有 build-tools 目录`)
  const aapt2 = path.join(buildToolsDir, 'aapt2.exe')
  const d8Jar = path.join(buildToolsDir, 'lib', 'd8.jar')
  const apksignerJar = path.join(buildToolsDir, 'lib', 'apksigner.jar')
  const zipalign = path.join(buildToolsDir, 'zipalign.exe')
  for (const file of [aapt2, d8Jar, apksignerJar]) {
    if (!fs.existsSync(file)) throw new Error(`缺少构建工具: ${file}`)
  }

  const javaHome = await detectJavaHome()
  const java = path.join(javaHome, 'bin', 'java.exe')
  const javac = path.join(javaHome, 'bin', 'javac.exe')
  const keytool = path.join(javaHome, 'bin', 'keytool.exe')
  const jar = path.join(javaHome, 'bin', 'jar.exe')
  for (const file of [java, javac, keytool, jar]) {
    if (!fs.existsSync(file)) throw new Error(`JDK 不完整，缺少 ${file}`)
  }

  return {
    androidJar,
    aapt2,
    zipalign,
    java,
    javac,
    keytool,
    jar,
    d8Jar,
    apksignerJar,
    platformDir,
    buildToolsDir,
    javaHome,
  }
}

// ── steps ───────────────────────────────────────────────────────────────────

async function compileResources(tools) {
  const out = path.join(BUILD, 'res.zip')
  await run(tools.aapt2, ['compile', '--dir', path.join(PROJECT, 'res'), '-o', out])
  return out
}

async function linkResources(tools, compiled) {
  const out = path.join(BUILD, 'base.apk')
  const args = [
    'link',
    '-o', out,
    '-I', tools.androidJar,
    '--manifest', path.join(PROJECT, 'AndroidManifest.xml'),
    '-R', compiled,
    '--java', GEN,
    '--min-sdk-version', String(MIN_SDK),
    '--target-sdk-version', String(TARGET_SDK),
    '--auto-add-overlay',
  ]
  const versionCode = flag('version-code')
  const versionName = flag('version-name')
  if (versionCode) args.push('--version-code', String(versionCode))
  if (versionName) args.push('--version-name', String(versionName))
  await run(tools.aapt2, args)
  return out
}

async function compileJava(tools) {
  const sources = [
    ...walk(path.join(PROJECT, 'java'), (f) => f.endsWith('.java')),
    ...walk(GEN, (f) => f.endsWith('.java')),
  ]
  if (sources.length === 0) throw new Error('没有找到任何 .java 源文件')
  fs.mkdirSync(CLASSES, { recursive: true })

  // An argument file keeps a large source set off the command line limit and
  // survives spaces in paths.  Paths use forward slashes because javac treats a
  // backslash inside an @argfile as an escape character.
  const toArgPath = (file) => file.replace(/\\/g, '/')
  const argFile = path.join(BUILD, 'javac.args')
  const lines = [
    '--release', String(JAVA_RELEASE),
    '-encoding', 'UTF-8',
    '-nowarn',
    '-classpath', toArgPath(tools.androidJar),
    '-d', toArgPath(CLASSES),
    ...sources.map((file) => `"${toArgPath(file)}"`),
  ]
  fs.writeFileSync(argFile, `${lines.join('\n')}\n`, 'utf8')
  await run(tools.javac, [`@${argFile}`])
  return sources.length
}

async function dexClasses(tools) {
  fs.mkdirSync(DEX, { recursive: true })
  // d8 takes archives far more happily than thousands of loose .class paths, and
  // a jar also avoids the Windows command-line length limit.
  const classesJar = path.join(BUILD, 'classes.jar')
  await run(tools.jar, ['--create', '--file', classesJar, '-C', CLASSES, '.'])
  await run(tools.java, [
    '-cp', tools.d8Jar,
    'com.android.tools.r8.D8',
    '--release',
    '--lib', tools.androidJar,
    '--min-api', String(MIN_SDK),
    '--output', DEX,
    classesJar,
  ])
  const dex = path.join(DEX, 'classes.dex')
  if (!fs.existsSync(dex)) throw new Error('d8 没有产出 classes.dex')
  return dex
}

/**
 * Assemble the final APK.
 *
 * `resources.arsc` and `classes.dex` are written **stored** (not deflated) and
 * 4-byte aligned: the platform mmaps both, and a deflated `resources.arsc` costs
 * a full copy of the resource table at every process start.
 */
function packageApk(baseApk, dexFile) {
  const entries = readZip(fs.readFileSync(baseApk))
  const out = []
  const stored = (name) => name === 'resources.arsc' || name.endsWith('.dex')

  for (const [name, data] of entries) {
    // Align every entry to 4 bytes (what `zipalign` does) and additionally store
    // the two the platform mmaps.
    out.push({ name, data, compress: !stored(name), align: 4 })
  }
  out.push({ name: 'classes.dex', data: fs.readFileSync(dexFile), compress: false, align: 4 })

  // resources.arsc first, then the dex, then the rest — the order the platform's
  // zip reader prefers.
  out.sort((a, b) => rank(a.name) - rank(b.name))
  const buffer = writeZip(out)
  const target = path.join(BUILD, 'unsigned.apk')
  fs.writeFileSync(target, buffer)
  return { target, bytes: buffer.length, entries: out.length }
}

function rank(name) {
  if (name === 'resources.arsc') return 0
  if (name === 'AndroidManifest.xml') return 1
  if (name === 'classes.dex') return 2
  if (name.startsWith('classes') && name.endsWith('.dex')) return 3
  if (name.startsWith('res/')) return 4
  return 5
}

/**
 * The signing key must survive a rebuild.
 *
 * `BUILD` is wiped at the start of every run, so a keystore inside it would be
 * regenerated each time — and the device rejects the next install with
 * INSTALL_FAILED_UPDATE_INCOMPATIBLE because the signature changed. Keeping it
 * beside the project makes the key stable across builds.
 */
async function ensureKeystore(tools) {
  const keystore = path.resolve(String(flag('keystore', path.join(PROJECT, 'debug.keystore'))))
  if (fs.existsSync(keystore)) return keystore
  fs.mkdirSync(path.dirname(keystore), { recursive: true })
  await run(tools.keytool, [
    '-genkeypair',
    '-keystore', keystore,
    '-storetype', 'PKCS12',
    '-alias', 'androiddebugkey',
    '-keyalg', 'RSA',
    '-keysize', '2048',
    '-validity', '10000',
    '-storepass', 'android',
    '-keypass', 'android',
    '-dname', 'CN=Android Debug,O=Android,C=US',
  ])
  console.log(`      已生成签名密钥: ${keystore}`)
  return keystore
}

async function signApk(tools, unsigned, keystore) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  await run(tools.java, [
    '-cp', tools.apksignerJar,
    'com.android.apksigner.ApkSignerTool',
    'sign',
    '--ks', keystore,
    '--ks-type', 'PKCS12',
    '--ks-pass', 'pass:android',
    '--key-pass', 'pass:android',
    '--ks-key-alias', 'androiddebugkey',
    '--min-sdk-version', String(MIN_SDK),
    '--out', OUT,
    unsigned,
  ])
  const verify = await run(tools.java, [
    '-cp', tools.apksignerJar,
    'com.android.apksigner.ApkSignerTool',
    'verify',
    '--min-sdk-version', String(MIN_SDK),
    '--print-certs',
    OUT,
  ])
  const signer = /Signer #1 certificate DN:\s*(.+)/.exec(verify.stdout)?.[1]?.trim() ?? '(unknown)'
  return signer
}

// ── main ────────────────────────────────────────────────────────────────────

const started = Date.now()
if (!fs.existsSync(PROJECT)) throw new Error(`项目目录不存在: ${PROJECT}`)

console.log(`项目 : ${PROJECT}`)
console.log(`SDK  : ${SDK}`)
console.log(`输出 : ${OUT}\n`)

fs.rmSync(BUILD, { recursive: true, force: true })
fs.mkdirSync(BUILD, { recursive: true })

const tools = await resolveToolchain()
console.log(`JDK     : ${tools.javaHome}`)
console.log(`platform: ${path.basename(tools.platformDir)}`)
console.log(`tools   : ${path.basename(tools.buildToolsDir)}\n`)

console.log('[1/6] aapt2 compile  (resources)')
const compiled = await compileResources(tools)

console.log('[2/6] aapt2 link     (manifest + resources → APK skeleton, R.java)')
const baseApk = await linkResources(tools, compiled)

console.log('[3/6] javac          (sources)')
const sourceCount = await compileJava(tools)

console.log('[4/6] d8             (classes → classes.dex)')
const dex = await dexClasses(tools)

console.log('[5/6] package        (store + align resources.arsc / classes.dex)')
const packaged = packageApk(baseApk, dex)

const misaligned = findMisalignedEntries(fs.readFileSync(packaged.target), 4)
if (misaligned.length > 0) {
  throw new Error(`打包结果未 4 字节对齐: ${JSON.stringify(misaligned.slice(0, 5))}`)
}

console.log('[6/6] apksigner      (sign + verify)')
const keystore = await ensureKeystore(tools)
const signer = await signApk(tools, packaged.target, keystore)

if (fs.existsSync(tools.zipalign)) {
  const align = await run(tools.zipalign, ['-c', '-v', '4', OUT], { allowFailure: true })
  const ok = align.code === 0
  console.log(`      zipalign -c 4 : ${ok ? '通过' : '未通过（见下）'}`)
  if (!ok) console.log(align.stdout.trim().split('\n').slice(-5).join('\n'))
}

const summary = apkSummary(OUT)
console.log('')
console.log(`APK      : ${OUT}`)
console.log(`package  : ${summary.package}`)
console.log(`version  : ${summary.versionName} (${summary.versionCode})`)
console.log(`sdk      : min=${summary.minSdk} target=${summary.targetSdk}`)
console.log(`size     : ${(summary.sizeBytes / 1024).toFixed(1)} KB`)
console.log(`entries  : ${packaged.entries}`)
console.log(`sources  : ${sourceCount}`)
console.log(`signer   : ${signer}`)
console.log(`耗时     : ${((Date.now() - started) / 1000).toFixed(1)}s`)
