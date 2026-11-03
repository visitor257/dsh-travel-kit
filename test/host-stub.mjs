/**
 * 宿主桩测试：用假的 ctx 调 apply()，验证工具与 skill 注册、以及工具真实执行。
 * 不需要 DSH 进程，也不碰真实联接（所有安装目录都指向临时目录）。
 *
 * 运行：
 *   "<node>" test/host-stub.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = await import(pathToFileURL(path.join(here, '..', 'src', 'index.js')).href)

let failures = 0
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`  PASS  ${label}${extra ? '  ' + extra : ''}`)
  else { failures++; console.log(`  FAIL  ${label}${extra ? '  ' + extra : ''}`) }
}

const tools = new Map()
const skills = new Map()
const ctx = {
  tools: { register: (t) => tools.set(t.name, t) },
  skills: { register: (s) => skills.set(s.name, s) },
}

console.log('[1] 模块导出')
ok(pkg.name === 'dsh-travel-kit', 'name', pkg.name)
ok(Array.isArray(pkg.inject) && pkg.inject.includes('tools'), 'inject', JSON.stringify(pkg.inject))
ok(typeof pkg.apply === 'function', 'apply 是函数')
console.log(`      defineTool 来源: ${pkg.toolsSource}`)

console.log('\n[2] apply 注册')
pkg.apply(ctx)
ok(skills.has('dsh-travel-kit'), 'skill 已注册')
ok(tools.size === 4, '注册 4 个工具', [...tools.keys()].join(', '))
for (const t of tools.values()) {
  ok(typeof t.execute === 'function' && typeof t.name === 'string' && t.output, `${t.name} 结构完整`)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-travel-stub-'))
const realInstall = process.env.DSH_TEST_INSTALL || 'D:\\Program Files\\DeepSeek Harness'

console.log('\n[3] travel_status（真实安装目录，只读）')
const status = await tools.get('travel_status').execute({})
ok(typeof status === 'string' && status.includes('联接状态'), '返回状态文本')
console.log(status.split('\n').slice(0, 6).map((l) => '      ' + l).join('\n'))

console.log('\n[4] travel_export -> 临时目录')
const exp = await tools.get('travel_export').execute({ bundleRoot: path.join(tmp, 'bundles'), note: 'stub test' })
ok(exp.includes('打包完成'), '导出成功')
const bundlePath = (exp.match(/目录: (.+)/) || [])[1]?.trim()
ok(bundlePath && fs.existsSync(bundlePath), '包目录存在', bundlePath || '(无)')

console.log('\n[5] travel_inspect')
const ins = await tools.get('travel_inspect').execute({ bundlePath })
ok(ins.includes('校验通过'), '校验通过')

console.log('\n[6] travel_restore dryRun（指向临时安装目录，不碰真实联接）')
const fake = path.join(tmp, 'fakeinstall')
fs.mkdirSync(path.join(fake, 'data', 'dsh-home'), { recursive: true })
const dry = await tools.get('travel_restore').execute({ bundlePath, installDir: fake, dryRun: true, fixLinks: false })
ok(dry.includes('演练结果'), '默认 dryRun 不写入')
ok(fs.readdirSync(path.join(fake, 'data', 'dsh-home')).length === 0, '临时目录仍为空')

console.log('\n[7] travel_restore 真恢复（临时目录）')
const real = await tools.get('travel_restore').execute({ bundlePath, installDir: fake, dryRun: false, fixLinks: false })
ok(real.includes('恢复完成'), '恢复执行')
const sess = fs.readdirSync(path.join(fake, 'data', 'dsh-home', 'sessions'), { withFileTypes: true }).filter((e) => e.isDirectory()).length
ok(sess >= 1, '会话已还原', String(sess))
ok(fs.existsSync(path.join(fake, 'data', 'dsh-home', 'storages', 'workspace.json')), '工作区已还原')

fs.rmSync(tmp, { recursive: true, force: true })
console.log('')
console.log(failures ? `结果：${failures} 项失败` : '结果：全部通过')
process.exit(failures ? 1 : 0)
