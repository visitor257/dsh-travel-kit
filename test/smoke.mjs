/**
 * 离线冒烟测试：不依赖 DSH 宿主，直接用 node 跑 core.js。
 *
 * 覆盖：探知布局 → 打包 → 校验 → 演练恢复 → 真恢复（到临时目录） → 报告内容
 *
 * 运行：
 *   "D:\Program Files\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" test/smoke.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  detectLayout,
  exportBundle,
  inspectBundle,
  restoreBundle,
  defaultBundleRoot,
  buildReport,
  readPlugins,
  readWorkspaces,
} from '../src/core.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const installDir = process.env.DSH_TEST_INSTALL || 'D:\\Program Files\\DeepSeek Harness'

let failures = 0
function ok(cond, label, extra = '') {
  if (cond) {
    console.log(`  PASS  ${label}${extra ? '  ' + extra : ''}`)
  } else {
    failures++
    console.log(`  FAIL  ${label}${extra ? '  ' + extra : ''}`)
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-travel-test-'))
console.log(`临时目录: ${tmp}`)
console.log(`安装目录: ${installDir}\n`)

/* 1. 探知 */
console.log('[1] detectLayout')
const layout = detectLayout(installDir)
ok(layout.dshHome.endsWith(path.join('data', 'dsh-home')), 'dshHome 路径正确', layout.dshHome)
ok(layout.links.length === 3, '三条联接规格', String(layout.links.length))
ok(layout.counts.sessions >= 0, '会话数可读', String(layout.counts.sessions))
console.log(`      版本=${layout.appVersion} 会话=${layout.counts.sessions} 工作区=${layout.counts.workspaces}`)
for (const l of layout.links) console.log(`      ${l.id}: ${l.type}`)

/* 2. 打包 */
console.log('\n[2] exportBundle')
const exp = exportBundle({ installDir, bundleRoot: path.join(tmp, 'bundle'), note: 'smoke test' })
ok(fs.existsSync(exp.bundlePath), '包目录已创建')
ok(fs.existsSync(path.join(exp.bundlePath, 'manifest.json')), 'manifest.json 存在')
ok(fs.existsSync(path.join(exp.bundlePath, 'report.md')), 'report.md 存在')
ok(exp.manifest.files.length > 20, '清单文件数 > 20', String(exp.manifest.files.length))
ok(exp.manifest.counts.sessions > 0, '包内会话数 > 0', String(exp.manifest.counts.sessions))
ok(fs.existsSync(path.join(exp.bundlePath, 'data', 'dsh-home', '.credentials.yaml')), '凭证已包含')
ok(fs.existsSync(path.join(exp.bundlePath, 'layout', 'layout.json')), 'layout.json 存在')
console.log(`      包: ${exp.bundlePath}`)
console.log(`      ${exp.manifest.counts.files} 文件, ${(exp.manifest.counts.bytes / 1024 / 1024).toFixed(1)} MB`)

/* 3. 校验 */
console.log('\n[3] inspectBundle')
const ins = inspectBundle(exp.bundlePath)
ok(ins.ok, '校验通过', ins.problems.slice(0, 3).join(' | '))
ok(ins.verified === exp.manifest.files.length, '全部文件已核对', `${ins.verified}/${exp.manifest.files.length}`)

/* 4. 演练恢复（不落盘、不碰联接） */
console.log('\n[4] restoreBundle dryRun')
const fake = path.join(tmp, 'fakeinstall')
fs.mkdirSync(path.join(fake, 'data', 'dsh-home'), { recursive: true })
const dry = restoreBundle({ bundlePath: exp.bundlePath, installDir: fake, dryRun: true, fixLinks: false })
ok(dry.actions.length > 0, '有动作清单', String(dry.actions.length))
ok(fs.readdirSync(path.join(fake, 'data', 'dsh-home')).length === 0, 'dryRun 未写入任何文件')

/* 5. 真恢复（到临时安装目录，fixLinks=false 以避开真实联接） */
console.log('\n[5] restoreBundle real -> temp')
const real = restoreBundle({ bundlePath: exp.bundlePath, installDir: fake, dryRun: false, fixLinks: false })
const restoredHome = path.join(fake, 'data', 'dsh-home')
const restoredSessions = fs.existsSync(path.join(restoredHome, 'sessions'))
  ? fs.readdirSync(path.join(restoredHome, 'sessions'), { withFileTypes: true }).filter((e) => e.isDirectory()).length
  : 0
ok(restoredSessions === exp.manifest.counts.sessions, '会话数一致', `${restoredSessions}/${exp.manifest.counts.sessions}`)
ok(fs.existsSync(path.join(restoredHome, 'storages', 'workspace.json')), 'workspace.json 已还原')
ok(fs.existsSync(path.join(restoredHome, '.credentials.yaml')), '凭证已还原')
ok(fs.existsSync(path.join(restoredHome, 'profiles', 'desktop', 'package.json')), 'profile 配置已还原')
ok(fs.existsSync(path.join(restoredHome, 'profiles', 'desktop', '.plugin-manager')), '插件启用状态已还原')
console.log(`      动作 ${real.actions.length} 条`)

/* 6. 报告内容 */
console.log('\n[6] report content')
const report = fs.readFileSync(path.join(exp.bundlePath, 'report.md'), 'utf8')
for (const key of ['DSH 完整备份报告', '目录与联接结构', '工作区', '插件', '在本机恢复', '迁移到另一台电脑', '已知边界']) {
  ok(report.includes(key), `报告含「${key}」`)
}
ok(!/sk-[A-Za-z0-9]{10,}/.test(report), '报告未泄露密钥样式字符串')

/* 7. 插件/工作区读取 */
console.log('\n[7] readPlugins / readWorkspaces')
const plugins = readPlugins(layout.dshHome)
ok(Array.isArray(plugins.installed), '插件清单可读', `${plugins.installed.length} 个`)
const ws = readWorkspaces(layout.dshHome)
ok(Array.isArray(ws), '工作区清单可读', `${ws.length} 个`)

/* 清理 */
fs.rmSync(tmp, { recursive: true, force: true })

console.log('')
if (failures) {
  console.log(`结果：${failures} 项失败`)
  process.exit(1)
}
console.log('结果：全部通过')
