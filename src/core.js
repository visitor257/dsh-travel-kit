/**
 * dsh-travel-kit — 核心逻辑（纯 Node，无 DSH 依赖）
 *
 * 目标：把一台机器上的 DSH 完整"打包"（对话、工作区、插件与配置、设置、
 * 目录/联接结构），产出一份可读报告；在另一台机器（或更新损坏后的本机）
 * 上按报告还原。
 *
 * 这里不 import 任何 @deepseek-ai/* —— 只有 index.js 才依赖宿主 API，
 * 因此本文件可以用普通 node 直接跑测试。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

/**
 * Electron 把 app.asar 虚拟成目录，普通 fs 打不开它；original-fs 可以。
 * 纯 Node（CLI/测试）下没有这个模块，回落到普通 fs。
 */
let rawFs = fs
try {
  rawFs = createRequire(import.meta.url)('original-fs')
} catch {
  rawFs = fs
}

/* ------------------------------------------------------------------ 基础 */

function readSelfVersion() {
  try {
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
    const raw = fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8').replace(/^\uFEFF/, '')
    const pkg = JSON.parse(raw)
    return pkg.version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}
const GENERATOR_VERSION = readSelfVersion()

export function isWindows() {
  return process.platform === 'win32'
}

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function sha256File(file) {
  const h = crypto.createHash('sha256')
  h.update(fs.readFileSync(file))
  return h.digest('hex')
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function listFiles(root) {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      let st
      try {
        st = fs.lstatSync(full)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) walk(full)
      else if (st.isFile()) out.push(full)
    }
  }
  walk(root)
  return out
}

/** 递归复制目录；符号链接按原样重建（pnpm 的 .pnpm 内部是相对链接） */
function copyTree(src, dst, opts = {}) {
  if (!fs.existsSync(src)) return 0
  let copied = 0
  const stack = [[src, dst]]
  while (stack.length) {
    const [s, d] = stack.pop()
    const st = fs.lstatSync(s)
    if (st.isSymbolicLink()) {
      try {
        const link = fs.readlinkSync(s)
        ensureDir(path.dirname(d))
        fs.symlinkSync(link, d, isWindows() ? 'junction' : 'dir')
        copied++
      } catch {
        /* 链接目标无关紧要时跳过 */
      }
      continue
    }
    if (st.isDirectory()) {
      ensureDir(d)
      for (const e of fs.readdirSync(s, { withFileTypes: true })) {
        if (opts.skip && opts.skip.has(e.name) && s === src) continue
        stack.push([path.join(s, e.name), path.join(d, e.name)])
      }
    } else if (st.isFile()) {
      ensureDir(path.dirname(d))
      fs.copyFileSync(s, d)
      copied++
    }
  }
  return copied
}

/* -------------------------------------------------------------- 布局探知 */

/** 三处"程序默认会找的位置"，都与安装目录里的 data 对应 */
export function linkSpecs(installDir) {
  const data = path.join(installDir, 'data')
  return [
    {
      id: 'dsh-home',
      label: 'DSH 数据（对话/工作区/插件配置/凭证）',
      defaultPath: path.join(os.homedir(), '.dsh'),
      target: path.join(data, 'dsh-home'),
      env: 'DSH_HOME',
    },
    {
      id: 'electron-userdata',
      label: 'Electron 界面状态（窗口/本地存储）',
      defaultPath: isWindows()
        ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '@deepseek-ai', 'dsh-desktop')
        : path.join(os.homedir(), '.config', '@deepseek-ai', 'dsh-desktop'),
      target: path.join(data, 'electron-userdata'),
      env: null,
    },
    {
      id: 'dafeiyu-runtime',
      label: '桌宠运行时',
      defaultPath: isWindows()
        ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'dsh-dafeiyu')
        : path.join(os.homedir(), '.local', 'share', 'dsh-dafeiyu'),
      target: path.join(data, 'dafeiyu-runtime'),
      env: null,
    },
  ]
}

/** 读出每条联接的真实状态 */
export function detectLayout(installDir) {
  const links = linkSpecs(installDir).map((spec) => {
    const entry = { ...spec, exists: false, type: 'missing', actualTarget: null }
    try {
      const st = fs.lstatSync(spec.defaultPath)
      entry.exists = true
      if (st.isSymbolicLink()) {
        entry.type = isWindows() ? 'junction' : 'symlink'
        try {
          entry.actualTarget = fs.realpathSync(spec.defaultPath)
        } catch {
          entry.actualTarget = null
        }
      } else {
        entry.type = st.isDirectory() ? 'directory' : 'file'
      }
    } catch {
      /* 不存在 */
    }
    return entry
  })

  const dshHome = path.join(installDir, 'data', 'dsh-home')
  const profileDir = path.join(dshHome, 'profiles', 'desktop')

  return {
    platform: process.platform,
    hostname: os.hostname(),
    user: os.userInfo().username,
    installDir,
    dshHome,
    profileDir,
    appVersion: readAppVersion(installDir),
    nodeVersion: process.version,
    env: {
      DSH_HOME: process.env.DSH_HOME || null,
      DSH_PROFILE: process.env.DSH_PROFILE || null,
    },
    links,
    counts: {
      sessions: countDirs(path.join(dshHome, 'sessions')),
      workspaces: readWorkspaces(dshHome).length,
    },
  }
}

/**
 * 读应用版本。
 * 安装目录里的 `version` 文件是 Electron 的版本，不能用；真正的版本在
 * resources/app.asar 内的 package.json。asar 头部是 JSON 索引，可以直接定位。
 */
function readAppVersion(installDir) {
  return readVersionFromAsar(installDir) || readVersionFromRegistry() || null
}

function readVersionFromAsar(installDir) {
  const asar = path.join(installDir, 'resources', 'app.asar')
  let fd = null
  try {
    fd = rawFs.openSync(asar, 'r')
    const head = Buffer.alloc(16)
    rawFs.readSync(fd, head, 0, 16, 0)
    const jsonLen = head.readUInt32LE(12)
    if (!jsonLen || jsonLen > 64 * 1024 * 1024) return null
    const jsonBuf = Buffer.alloc(jsonLen)
    rawFs.readSync(fd, jsonBuf, 0, jsonLen, 16)
    const header = JSON.parse(jsonBuf.toString('utf8'))
    const entry = header?.files?.['package.json']
    if (!entry) return null
    const size = Math.min(Number(entry.size) || 0, 64 * 1024)
    const buf = Buffer.alloc(size)
    rawFs.readSync(fd, buf, 0, size, 16 + jsonLen + Number(entry.offset))
    const m = buf.toString('utf8').match(/"version"\s*:\s*"([^"]+)"/)
    return m ? m[1] : null
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        rawFs.closeSync(fd)
      } catch {
        /* 忽略 */
      }
    }
  }
}

/** 兜底：从卸载注册表读 DisplayVersion（Electron 内读 asar 失败时用） */
function readVersionFromRegistry() {
  if (process.platform !== 'win32') return null
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'DeepSeek Harness', '/v', 'DisplayVersion'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 },
    )
    const m = out.match(/DisplayVersion\s+REG_SZ\s+(\S+)/)
    return m ? m[1] : null
  } catch {
    return null
  }
}

function countDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length
  } catch {
    return 0
  }
}

/** 工作区清单（含每个工作区的会话数） */
export function readWorkspaces(dshHome) {
  const file = path.join(dshHome, 'storages', 'workspace.json')
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'))
    const table = json?.tables?.workspaces || {}
    return Object.entries(table).map(([id, w]) => ({
      id,
      title: w.title || '',
      path: w.path || '',
      sessions: Array.isArray(w.sessionIds) ? w.sessionIds.length : 0,
      updatedAt: w.updatedAt || null,
    }))
  } catch {
    return []
  }
}

/** 插件清单：profile 声明的依赖 + 实际安装版本 */
export function readPlugins(dshHome) {
  const profileDir = path.join(dshHome, 'profiles', 'desktop')
  const result = { declared: [], bundles: [], installed: [] }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    result.declared = Object.entries(pkg.dependencies || {}).map(([name, spec]) => ({ name, spec }))
    result.bundles = pkg?.dsh?.profile?.bundles || []
  } catch {
    /* profile 可能不存在 */
  }
  const nm = path.join(profileDir, 'node_modules')
  let entries = []
  try {
    entries = fs.readdirSync(nm, { withFileTypes: true })
  } catch {
    return result
  }
  for (const e of entries) {
    if (e.name === '.pnpm' || e.name.startsWith('.')) continue
    // 单个包读不出来不能影响其它包
    const rels = []
    if (e.name.startsWith('@')) {
      try {
        for (const x of fs.readdirSync(path.join(nm, e.name), { withFileTypes: true })) {
          rels.push(path.join(e.name, x.name))
        }
      } catch {
        continue
      }
    } else {
      rels.push(e.name)
    }
    for (const rel of rels) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(nm, rel, 'package.json'), 'utf8'))
        if (!p.name) continue
        if (!/dsh|cosplay|fish|travel/i.test(p.name)) continue
        if (result.installed.some((x) => x.name === p.name)) continue
        result.installed.push({ name: p.name, version: p.version || '' })
      } catch {
        /* 跳过这个包 */
      }
    }
  }
  return result
}

/* -------------------------------------------------------------- 导出打包 */

const DEFAULT_EXPORTS = ['sessions', 'storages', 'attachments', 'dsh-dafeiyu', 'llm-deepseek']
const PROFILE_FILES = [
  'cordis.yml',
  'cordis.patch.yml',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
]
const HOME_FILES = ['.credentials.yaml', '.anonymous-user-id']
const USERDATA_ITEMS = ['Local State', 'Preferences', path.join('Network', 'Network Persistent State')]

export function defaultBundleRoot() {
  if (process.env.DSH_TRAVEL_ROOT) return process.env.DSH_TRAVEL_ROOT
  if (isWindows()) {
    for (const drive of ['D:', 'E:']) {
      if (fs.existsSync(drive + '\\')) return drive + '\\DSH-Travel'
    }
  }
  return path.join(os.homedir(), 'DSH-Travel')
}

/**
 * 打包。
 * @param {object} opts
 * @param {string} [opts.bundleRoot] 输出的父目录
 * @param {string} opts.installDir    DSH 安装目录
 * @param {string} [opts.dshHome]     默认 <installDir>/data/dsh-home
 * @param {boolean} [opts.includeAttachments=true]
 * @param {boolean} [opts.includeUserData=true]
 * @param {boolean} [opts.includeCredentials=true]
 * @param {string} [opts.note]        追加到报告里的备注
 */
export function exportBundle(opts) {
  const installDir = opts.installDir
  const dshHome = opts.dshHome || path.join(installDir, 'data', 'dsh-home')
  if (!fs.existsSync(dshHome)) {
    throw new Error(`找不到 DSH 数据目录: ${dshHome}`)
  }

  const layout = detectLayout(installDir)
  const bundleRoot = opts.bundleRoot || defaultBundleRoot()
  const name = `DSH-Travel-${layout.hostname}-${stamp()}`
  const bundlePath = path.join(bundleRoot, name)
  const dataDir = path.join(bundlePath, 'data')
  const homeBackup = path.join(dataDir, 'dsh-home')
  ensureDir(homeBackup)

  const skipped = []
  const copiedDirs = []

  for (const item of DEFAULT_EXPORTS) {
    if (item === 'attachments' && opts.includeAttachments === false) {
      skipped.push(item)
      continue
    }
    const src = path.join(dshHome, item)
    if (!fs.existsSync(src)) continue
    copyTree(src, path.join(homeBackup, item))
    copiedDirs.push(item)
  }

  // profile：配置与本地插件包，不含 node_modules
  const profileSrc = path.join(dshHome, 'profiles', 'desktop')
  const profileDst = path.join(homeBackup, 'profiles', 'desktop')
  for (const f of PROFILE_FILES) {
    const s = path.join(profileSrc, f)
    if (!fs.existsSync(s)) continue
    ensureDir(profileDst)
    fs.copyFileSync(s, path.join(profileDst, f))
  }
  if (fs.existsSync(path.join(profileSrc, '.plugin-manager'))) {
    copyTree(path.join(profileSrc, '.plugin-manager'), path.join(profileDst, '.plugin-manager'))
  }
  try {
    for (const e of fs.readdirSync(profileSrc)) {
      if (!e.endsWith('.tgz')) continue
      ensureDir(profileDst)
      fs.copyFileSync(path.join(profileSrc, e), path.join(profileDst, e))
    }
  } catch {
    /* 忽略 */
  }

  // 插件代码：默认随包携带，这样还原后不依赖 pnpm（换路径/离网也能用）
  if (opts.includeModules !== false) {
    const srcNm = path.join(profileSrc, 'node_modules')
    if (fs.existsSync(srcNm)) {
      copyTree(srcNm, path.join(profileDst, 'node_modules'))
      copiedDirs.push('profiles/desktop/node_modules')
    }
  } else {
    skipped.push('profiles/desktop/node_modules')
  }

  // 顶层文件与凭证
  for (const f of HOME_FILES) {
    if (f === '.credentials.yaml' && opts.includeCredentials === false) {
      skipped.push(f)
      continue
    }
    const s = path.join(dshHome, f)
    if (!fs.existsSync(s)) continue
    fs.copyFileSync(s, path.join(homeBackup, f))
  }

  // Electron 界面状态
  if (opts.includeUserData !== false) {
    const udSrc = path.join(installDir, 'data', 'electron-userdata')
    const udDst = path.join(dataDir, 'electron-userdata')
    for (const item of USERDATA_ITEMS) {
      const s = path.join(udSrc, item)
      if (!fs.existsSync(s)) continue
      ensureDir(path.dirname(path.join(udDst, item)))
      fs.copyFileSync(s, path.join(udDst, item))
    }
    copyTree(path.join(udSrc, 'Local Storage'), path.join(udDst, 'Local Storage'))
  } else {
    skipped.push('electron-userdata')
  }
  skipped.push('data/dsh-runtimes')

  // 结构、插件、工作区
  const plugins = readPlugins(dshHome)
  const workspaces = readWorkspaces(dshHome)
  ensureDir(path.join(bundlePath, 'layout'))
  fs.writeFileSync(path.join(bundlePath, 'layout', 'layout.json'), JSON.stringify(layout, null, 2), 'utf8')
  fs.writeFileSync(path.join(bundlePath, 'layout', 'plugins.json'), JSON.stringify(plugins, null, 2), 'utf8')
  fs.writeFileSync(path.join(bundlePath, 'layout', 'workspaces.json'), JSON.stringify(workspaces, null, 2), 'utf8')

  // 清单 + 哈希
  const files = listFiles(bundlePath).map((abs) => {
    const st = fs.statSync(abs)
    return {
      path: path.relative(bundlePath, abs).split(path.sep).join('/'),
      size: st.size,
      sha256: sha256File(abs),
    }
  })
  const totalBytes = files.reduce((a, f) => a + f.size, 0)
  const manifest = {
    schema: 1,
    generator: 'dsh-travel-kit',
    generatorVersion: GENERATOR_VERSION,
    createdAt: new Date().toISOString(),
    name,
    appVersion: layout.appVersion,
    host: { hostname: layout.hostname, user: layout.user, platform: layout.platform },
    source: { installDir, dshHome },
    counts: { files: files.length, bytes: totalBytes, sessions: layout.counts.sessions, workspaces: workspaces.length },
    included: copiedDirs,
    skipped: [...new Set(skipped)],
    files,
  }
  fs.writeFileSync(path.join(bundlePath, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

  const report = buildReport({ manifest, layout, plugins, workspaces, note: opts.note })
  fs.writeFileSync(path.join(bundlePath, 'report.md'), report, 'utf8')

  return { bundlePath, reportPath: path.join(bundlePath, 'report.md'), manifest, layout, plugins, workspaces }
}

/* -------------------------------------------------------------- 校验 */

export function inspectBundle(bundlePath) {
  const manifestPath = path.join(bundlePath, 'manifest.json')
  if (!fs.existsSync(manifestPath)) throw new Error(`不是有效的包（缺少 manifest.json）: ${bundlePath}`)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const problems = []
  let verified = 0
  for (const f of manifest.files) {
    const abs = path.join(bundlePath, f.path.split('/').join(path.sep))
    if (!fs.existsSync(abs)) {
      problems.push(`缺少文件: ${f.path}`)
      continue
    }
    const size = fs.statSync(abs).size
    if (size !== f.size) {
      problems.push(`大小不符: ${f.path} (期望 ${f.size}, 实际 ${size})`)
      continue
    }
    verified++
  }
  return { manifest, verified, problems, ok: problems.length === 0 }
}

/* -------------------------------------------------------------- 恢复 */

function junctionCreate(linkPath, target) {
  ensureDir(path.dirname(linkPath))
  ensureDir(target)
  if (isWindows()) {
    execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, target], { stdio: 'pipe' })
  } else {
    fs.symlinkSync(target, linkPath, 'dir')
  }
}

function junctionRemove(linkPath) {
  if (isWindows()) {
    execFileSync('cmd', ['/c', 'rmdir', linkPath], { stdio: 'pipe' })
  } else {
    fs.unlinkSync(linkPath)
  }
}

/**
 * 从包恢复。
 * @param {object} opts
 * @param {string} opts.bundlePath
 * @param {string} opts.installDir  目标机器上的安装目录
 * @param {string} [opts.dshHome]   默认 <installDir>/data/dsh-home
 * @param {boolean} [opts.dryRun]   只报告将要做什么
 * @param {boolean} [opts.fixLinks=true] 重建三条联接
 * @param {boolean} [opts.moveAside=true] 现有数据目录改名留存
 */
export function restoreBundle(opts) {
  const bundlePath = opts.bundlePath
  const installDir = opts.installDir
  const dshHome = opts.dshHome || path.join(installDir, 'data', 'dsh-home')
  const dryRun = opts.dryRun === true
  const fixLinks = opts.fixLinks !== false
  const moveAside = opts.moveAside !== false

  const { manifest, problems } = inspectBundle(bundlePath)
  const actions = []
  const warnings = []

  if (manifest.appVersion) {
    const current = readAppVersion(installDir)
    if (current && current !== manifest.appVersion) {
      warnings.push(`版本不同：备份来自 ${manifest.appVersion}，当前 ${current}`)
    }
  }

  const srcHome = path.join(bundlePath, 'data', 'dsh-home')
  if (!fs.existsSync(srcHome)) throw new Error('包内缺少 data/dsh-home')

  // 1) 留存现有数据
  if (fs.existsSync(dshHome) && fs.readdirSync(dshHome).length > 0) {
    const aside = `${dshHome}.pre-restore-${stamp()}`
    if (moveAside) {
      actions.push(dryRun ? `将把现有数据改名留存: ${aside}` : `现有数据已改名留存: ${aside}`)
      if (!dryRun) fs.renameSync(dshHome, aside)
    } else {
      warnings.push('现有数据目录非空，未留存（moveAside=false）')
    }
  }

  // 2) 还原数据
  const sessionCount = countDirs(path.join(srcHome, 'sessions'))
  actions.push(`${dryRun ? '将还原' : '已还原'} ${sessionCount} 个会话目录及配置 -> ${dshHome}`)
  if (!dryRun) {
    ensureDir(dshHome)
    for (const item of ['sessions', 'storages', 'attachments', 'dsh-dafeiyu', 'llm-deepseek']) {
      copyTree(path.join(srcHome, item), path.join(dshHome, item))
    }
    const srcProfile = path.join(srcHome, 'profiles', 'desktop')
    const dstProfile = path.join(dshHome, 'profiles', 'desktop')
    for (const f of [...PROFILE_FILES, ...HOME_FILES]) {
      const s = path.join(srcHome, f.startsWith('.') ? f : path.join('profiles', 'desktop', f))
      const target = f.startsWith('.') ? path.join(dshHome, f) : path.join(dstProfile, f)
      if (!fs.existsSync(s)) continue
      ensureDir(path.dirname(target))
      fs.copyFileSync(s, target)
    }
    copyTree(path.join(srcProfile, '.plugin-manager'), path.join(dstProfile, '.plugin-manager'))
    try {
      for (const e of fs.readdirSync(srcProfile)) {
        if (e.endsWith('.tgz')) fs.copyFileSync(path.join(srcProfile, e), path.join(dstProfile, e))
      }
    } catch {
      /* 忽略 */
    }

    // 插件代码：随包携带时直接落位，并清掉 pnpm 记录的绝对路径状态
    const srcModules = path.join(srcProfile, 'node_modules')
    if (fs.existsSync(srcModules)) {
      const dstModules = path.join(dstProfile, 'node_modules')
      copyTree(srcModules, dstModules)
      for (const stale of ['.modules.yaml', '.pnpm-workspace-state-v1.json', path.join('.pnpm', 'lock.yaml')]) {
        try {
          fs.rmSync(path.join(dstModules, stale), { force: true })
        } catch {
          /* 忽略 */
        }
      }
      actions.push('已还原插件代码（node_modules），并清理 pnpm 绝对路径状态')
    } else if (fs.existsSync(path.join(dstProfile, 'node_modules'))) {
      warnings.push('包内没有 node_modules：目标机将沿用现有插件目录，可能与被还原的 package.json 不一致')
    } else {
      warnings.push('包内没有 node_modules，且目标机尚未安装：首次启动需联网重装插件')
    }
  }

  // 3) 界面状态
  const srcUd = path.join(bundlePath, 'data', 'electron-userdata')
  if (fs.existsSync(srcUd)) {
    const dstUd = path.join(installDir, 'data', 'electron-userdata')
    actions.push(`${dryRun ? '将还原' : '已还原'} 界面状态 -> ${dstUd}`)
    if (!dryRun) {
      for (const item of USERDATA_ITEMS) {
        const s = path.join(srcUd, item)
        if (!fs.existsSync(s)) continue
        ensureDir(path.dirname(path.join(dstUd, item)))
        fs.copyFileSync(s, path.join(dstUd, item))
      }
      copyTree(path.join(srcUd, 'Local Storage'), path.join(dstUd, 'Local Storage'))
    }
  }

  // 4) 联接
  if (fixLinks) {
    for (const spec of linkSpecs(installDir)) {
      if (!fs.existsSync(spec.target)) {
        warnings.push(`跳过联接（目标不存在）: ${spec.target}`)
        continue
      }
      let type = 'missing'
      try {
        const st = fs.lstatSync(spec.defaultPath)
        type = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'directory' : 'file'
      } catch {
        /* 不存在 */
      }
      if (type === 'missing') {
        actions.push(`${dryRun ? '将建立' : '已建立'}联接 ${spec.defaultPath} -> ${spec.target}`)
        if (!dryRun) junctionCreate(spec.defaultPath, spec.target)
      } else if (type === 'link') {
        let actual = null
        try {
          actual = fs.realpathSync(spec.defaultPath)
        } catch {
          actual = null
        }
        if (actual && path.resolve(actual).toLowerCase() === path.resolve(spec.target).toLowerCase()) {
          actions.push(`联接已正确 ${spec.defaultPath}`)
        } else {
          actions.push(`${dryRun ? '将重指' : '已重指'}联接 ${spec.defaultPath} -> ${spec.target}`)
          if (!dryRun) {
            junctionRemove(spec.defaultPath)
            junctionCreate(spec.defaultPath, spec.target)
          }
        }
      } else {
        const aside = `${spec.defaultPath}.diverted-${stamp()}`
        actions.push(`${dryRun ? '将把占用目录改名留存' : '占用目录已留存'}: ${aside}`)
        if (!dryRun) {
          fs.renameSync(spec.defaultPath, aside)
          junctionCreate(spec.defaultPath, spec.target)
        }
      }
    }
  }

  return { dryRun, problems, warnings, actions, manifest }
}

/** 插件完整性校验：package.json 声明的每个依赖是否真的在 node_modules 里 */
export function verifyProfile(dshHome) {
  const profileDir = path.join(dshHome, 'profiles', 'desktop')
  const nm = path.join(profileDir, 'node_modules')
  const entries = []
  let pkg = null
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return { ok: false, entries: [], reason: '读不到 profiles/desktop/package.json' }
  }
  for (const [name, spec] of Object.entries(pkg.dependencies || {})) {
    const dir = path.join(nm, ...name.split('/'))
    let installed = null
    try {
      const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
      installed = p.version || null
    } catch {
      installed = null
    }
    let status
    if (!installed) status = 'missing'
    else if (String(spec).startsWith('file:')) status = 'ok'
    else {
      const want = String(spec).replace(/^[\^~>=<]+/, '').split(' ')[0]
      status = installed === want || installed.startsWith(want + '.') ? 'ok' : 'version-mismatch'
    }
    entries.push({ name, declared: String(spec), installed, status })
  }
  return { ok: entries.every((e) => e.status === 'ok'), entries, reason: null }
}

/* -------------------------------------------------------------- 报告 */

export function buildReport({ manifest, layout, plugins, workspaces, note }) {
  const fmtMB = (b) => (b / 1024 / 1024).toFixed(1)
  const linkRows = layout.links
    .map((l) => `| ${l.label} | \`${l.defaultPath}\` | \`${l.target}\` | ${l.type}${l.actualTarget && l.type !== 'missing' ? `（实际指向 \`${l.actualTarget}\`）` : ''} |`)
    .join('\n')
  const pluginRows = plugins.installed.length
    ? plugins.installed.map((p) => `| ${p.name} | ${p.version} |`).join('\n')
    : '| （无） | |'
  const declaredRows = plugins.declared.length
    ? plugins.declared.map((d) => `| ${d.name} | \`${d.spec}\` |`).join('\n')
    : '| （无） | |'
  const wsRows = workspaces.length
    ? workspaces.map((w) => `| ${w.title} | \`${w.path}\` | ${w.sessions} |`).join('\n')
    : '| （无） | | |'

  return `# DSH 完整备份报告

生成时间：${manifest.createdAt}
生成工具：${manifest.generator} v${manifest.generatorVersion}
包名：\`${manifest.name}\`

## 1. 概况

| 项 | 值 |
|---|---|
| 主机 | ${layout.hostname}（用户 ${layout.user}，${layout.platform}） |
| DSH 版本 | ${layout.appVersion || '未知'} |
| 安装目录 | \`${layout.installDir}\` |
| 数据目录（DSH_HOME） | \`${layout.dshHome}\` |
| 会话目录数 | ${manifest.counts.sessions} |
| 工作区数 | ${manifest.counts.workspaces} |
| 包内文件 | ${manifest.counts.files} 个，${fmtMB(manifest.counts.bytes)} MB |
${note ? `| 备注 | ${note} |` : ''}

## 2. 目录与联接结构

这台机器把"程序默认会找的位置"用目录联接重定向到安装目录里的 \`data\\\`：

| 用途 | 默认路径（程序会找的地方） | 实际指向 | 当前状态 |
|---|---|---|---|
${linkRows}

**这一点是"更新后看起来像新装"的根源**：任一条联接被更新替换成普通空目录，
程序就会在默认位置新建一套空状态；数据本身没丢，只是没被找到。

## 3. 工作区

| 标题 | 路径 | 会话数 |
|---|---|---|
${wsRows}

> 会话目录名由工作区路径生成（如 \`--D-Documents-deepseek-harness-workplace01--\`）。
> 迁移到另一台电脑后，如果盘符/路径不同，会话仍在，但工作区条目需要重新指向新路径。

## 4. 插件

已安装：

| 包名 | 版本 |
|---|---|
${pluginRows}

profile 声明（\`profiles/desktop/package.json\`）：

| 包名 | 声明 |
|---|---|
${declaredRows}

启用为 bundle：${plugins.bundles.map((b) => `\`${b}\``).join('、') || '（无）'}

> 插件依赖（\`node_modules\`）**不在包内**，恢复后首次启动会按 \`package.json\` 自动重装。
> 本地打包的插件（\`*.tgz\`）已随包携带。

## 5. 包内含什么

已包含：${manifest.included.map((x) => `\`${x}\``).join('、') || '（无）'}

未包含（可重建或体积过大）：${manifest.skipped.map((x) => `\`${x}\``).join('、')}

- \`data/dsh-home/\`：对话、工作区、profile 配置、插件启用状态、凭证
- \`data/electron-userdata/\`：窗口与本地存储状态
- \`layout/layout.json\`：安装路径、联接映射、环境变量
- \`layout/plugins.json\`、\`layout/workspaces.json\`：清单
- \`manifest.json\`：每个文件的大小与 SHA-256

## 6. 在本机恢复（更新后"变新装"）

1. 完全退出 DeepSeek Harness（含托盘图标）。
2. 让 agent 执行：\`travel_restore\`，参数 \`bundlePath\` 指向本包。
3. 重开 DSH，等待插件自动重装。

恢复时会把现有数据改名留存为 \`dsh-home.pre-restore-<时间>\`，不会删除任何东西。

## 7. 迁移到另一台电脑

1. 在新电脑安装同版本（或相近版本）的 DSH，并至少启动一次，让它生成空的 \`data\` 结构。
2. 把本包整个目录拷过去（\`data\` 里含凭证，注意保管）。
3. 在新机器的 DSH 里安装 \`dsh-travel-kit\` 插件，重开 DSH。
4. 让 agent 执行：\`travel_restore\`，参数 \`bundlePath\` 指向新机器上的包路径；
   如新机器 DSH 装在别处，再传 \`installDir\`。
5. 重启 DSH。若盘符/路径不同：
   - 对话内容会回来，但工作区路径指向旧机器，需要手动重新添加工作区；
   - 三条联接由工具按新安装目录重建。

## 8. 没有工具时的手工恢复（兜底）

如果 DSH 起不来、插件也调不到，本包仍是普通目录，可以纯手工恢复。
**先完全退出 DSH**，然后在 PowerShell 里执行（把路径换成实际值）：

\`\`\`powershell
$b    = "<本包目录>"
$ins  = "${layout.installDir}"
$home = "$ins\\data\\dsh-home"

# 1) 现有数据改名留存（不删）
Rename-Item $home "$home.pre-manual-$(Get-Date -Format yyyyMMdd-HHmmss)" -ErrorAction SilentlyContinue

# 2) 复制回来
robocopy "$b\\data\\dsh-home"          $home                                /E
robocopy "$b\\data\\electron-userdata" "$ins\\data\\electron-userdata"      /E

# 3) 重建三条目录联接（先确认路径不存在，或已是联接）
cmd /c mklink /J "$env:USERPROFILE\\.dsh"                          $home
cmd /c mklink /J "$env:APPDATA\\@deepseek-ai\\dsh-desktop"          "$ins\\data\\electron-userdata"
cmd /c mklink /J "$env:LOCALAPPDATA\\dsh-dafeiyu"                   "$ins\\data\\dafeiyu-runtime"

# 4) 启动 DSH
\`\`\`

注意：\`mklink /J\` 建联接前，目标路径必须不存在或是已有联接；若是普通目录，
先用 \`Rename-Item\` 改名留存，再建联接。

## 9. 已知边界

- \`.credentials.yaml\` 是明文，包内含有，请勿外传。
- \`dsh-runtimes\`（运行时可下载）与 \`node_modules\`（按 lock 重装）不在包内。
- 会话文件是 zstd 压缩的追加日志；备份时若正在对话，最后几条可能截断。
- 恢复涉及替换正在使用的数据目录，**必须在 DSH 完全退出后**执行。
`
}
