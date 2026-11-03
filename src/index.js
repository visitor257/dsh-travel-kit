/**
 * dsh-travel-kit — 插件入口（DSH 宿主侧）。
 *
 * 只做两件事：
 *   1. 注册一个 skill，告诉模型什么时候、按什么顺序用这些工具；
 *   2. 注册 4 个工具，把 core.js 的能力暴露给 agent。
 *
 * 所有重活都在 core.js（纯 Node），因此即使宿主 API 变化，逻辑也能单独测试。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  detectLayout,
  exportBundle,
  inspectBundle,
  restoreBundle,
  defaultBundleRoot,
  readPlugins,
  verifyProfile,
} from './core.js'
import { SKILL_CONTENT, SKILL_DESCRIPTION, SKILL_NAME, SKILL_WHEN_TO_USE } from './skill.js'

/**
 * 宿主的 defineTool 只是给工具补默认字段（实测返回 name/description/
 * parameters/output/execute 原样对象）。这里动态导入并在失败时降级，
 * 避免"宿主模块解析不到"导致整棵插件树启动失败。
 */
let defineTool = (tool) => tool
let defineToolSource = 'builtin'
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  if (typeof mod.defineTool === 'function') {
    defineTool = mod.defineTool
    defineToolSource = 'host'
  }
} catch (error) {
  console.error('[dsh-travel-kit] 未解析到宿主 @deepseek-ai/dsh-tools，使用内置定义:', error?.message ?? error)
}

export const name = 'dsh-travel-kit'
export const inject = ['tools', 'skills']
/** 诊断用：'host' 表示用上了宿主的 defineTool，'builtin' 表示降级 */
export const toolsSource = defineToolSource

const textOutput = {
  schema: { type: 'string' },
  render(_args, value) {
    return [{ type: 'text', text: String(value) }]
  },
}

/**
 * 推断 DSH 安装目录。
 * 打包形态下 process.execPath 就是安装根目录里的 exe；但插件也可能被
 * 其它进程/测试加载，所以先从 DSH_HOME 反推，再向上找 resources/app.asar。
 */
function resolveInstallDir(override) {
  if (override) return path.resolve(override)

  const home = process.env.DSH_HOME
  if (home) {
    const dataDir = path.dirname(home)
    if (path.basename(dataDir).toLowerCase() === 'data') return path.dirname(dataDir)
  }

  let dir = path.dirname(process.execPath)
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'resources', 'app.asar'))) return dir
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return path.dirname(process.execPath)
}

export function apply(ctx) {
  ctx.skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    whenToUse: SKILL_WHEN_TO_USE,
    content: SKILL_CONTENT,
    source: 'runtime',
  })

  ctx.tools.register(defineTool({
    name: 'travel_status',
    description: '查看当前 DSH 的数据/安装位置、三条目录联接状态、工作区与插件清单。用于判断"看起来像新装"是否因为联接失效或 home 变空。',
    parameters: {
      installDir: { type: 'string', description: '自定义 DSH 安装目录；省略时按当前进程推断。' },
    },
    output: textOutput,
    async execute(args) {
      const layout = detectLayout(resolveInstallDir(args.installDir))
      const plugins = readPlugins(layout.dshHome)
      const lines = [
        `安装目录: ${layout.installDir}`,
        `数据目录: ${layout.dshHome}`,
        `DSH 版本: ${layout.appVersion || '未知'}`,
        `会话目录: ${layout.counts.sessions} 个   工作区: ${layout.counts.workspaces} 个`,
        '',
        '插件:',
        ...(plugins.installed.length
          ? plugins.installed.map((p) => `  ${p.name} ${p.version}`)
          : ['  （读不到 node_modules）']),
        `  本插件 defineTool 来源: ${toolsSource}`,
        '',
        '联接状态:',
        ...layout.links.map((l) => `  ${l.type === 'junction' || l.type === 'symlink' ? 'OK ' : '!! '}${l.defaultPath} -> ${l.target}  [${l.type}]${l.actualTarget ? ` 实际: ${l.actualTarget}` : ''}`),
        '',
        `默认打包目录: ${defaultBundleRoot()}`,
      ]
      return lines.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'travel_export',
    description: '把当前 DSH 完整打包：对话、工作区、插件与配置、凭证、界面状态、目录联接结构，并生成一份可读报告（report.md）与带哈希的清单（manifest.json）。用于备份或迁移到另一台电脑。',
    parameters: {
      bundleRoot: { type: 'string', description: '输出父目录；省略时用默认（D:\\DSH-Travel）。' },
      installDir: { type: 'string', description: '自定义安装目录。' },
      note: { type: 'string', description: '写入报告的备注，例如"迁移前备份"。' },
      includeAttachments: { type: 'boolean', description: '是否包含附件，默认 true。' },
      includeCredentials: { type: 'boolean', description: '是否包含登录凭证，默认 true；共享备份时可设为 false。' },
      includeModules: { type: 'boolean', description: '是否把插件代码（node_modules，约 235 MB）一起打包，默认 true；设为 false 得到约 12 MB 精简包，但还原后需联网重装插件。' },
    },
    output: textOutput,
    async execute(args) {
      const installDir = resolveInstallDir(args.installDir)
      const r = exportBundle({
        installDir,
        bundleRoot: args.bundleRoot,
        note: args.note,
        includeAttachments: args.includeAttachments !== false,
        includeCredentials: args.includeCredentials !== false,
        includeModules: args.includeModules !== false,
      })
      return [
        '打包完成',
        `  目录: ${r.bundlePath}`,
        `  报告: ${r.reportPath}`,
        `  会话: ${r.manifest.counts.sessions} 个   工作区: ${r.manifest.counts.workspaces} 个`,
        `  文件: ${r.manifest.counts.files} 个   ${(r.manifest.counts.bytes / 1024 / 1024).toFixed(1)} MB`,
        `  未包含: ${r.manifest.skipped.join(', ')}`,
        '',
        '说明：本包含明文凭证，请妥善保管；迁移到另一台机器后可用 travel_restore 还原。',
      ].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'travel_inspect',
    description: '校验一个备份包：检查 manifest、文件是否齐全、大小是否一致，并给出会话/工作区/插件概况。恢复前先跑这个。',
    parameters: {
      bundlePath: { type: 'string', required: true, description: '备份包目录，例如 D:\\DSH-Travel\\DSH-Travel-PC-2026-11-03_160000。' },
    },
    output: textOutput,
    async execute(args) {
      const r = inspectBundle(path.resolve(args.bundlePath))
      const m = r.manifest
      const lines = [
        r.ok ? '校验通过' : '校验发现问题',
        `  包名: ${m.name}`,
        `  生成时间: ${m.createdAt}`,
        `  来源: ${m.source.installDir}`,
        `  DSH 版本: ${m.appVersion || '未知'}   主机: ${m.host.hostname}`,
        `  会话: ${m.counts.sessions} 个   工作区: ${m.counts.workspaces} 个   文件: ${m.counts.files} 个`,
        `  已核对: ${r.verified} 个文件`,
      ]
      if (r.problems.length) {
        lines.push('', '问题:')
        for (const p of r.problems.slice(0, 20)) lines.push(`  - ${p}`)
        if (r.problems.length > 20) lines.push(`  ... 共 ${r.problems.length} 项`)
      }
      return lines.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'travel_restore',
    description: '从备份包恢复 DSH 数据（对话、工作区、插件配置、凭证、界面状态）并重建目录联接。默认 dryRun 只报告不落盘；真正恢复需传 dryRun=false，并在 DSH 完全退出后重启生效。',
    parameters: {
      bundlePath: { type: 'string', required: true, description: '备份包目录。' },
      installDir: { type: 'string', description: '目标机器上的 DSH 安装目录；省略时按当前进程推断。' },
      dryRun: { type: 'boolean', description: 'true 仅演练；false 才真正写入。默认 true。' },
      fixLinks: { type: 'boolean', description: '是否重建三条目录联接，默认 true。' },
    },
    output: textOutput,
    async execute(args) {
      const installDir = resolveInstallDir(args.installDir)
      const dryRun = args.dryRun !== false
      const r = restoreBundle({
        bundlePath: path.resolve(args.bundlePath),
        installDir,
        dryRun,
        fixLinks: args.fixLinks !== false,
      })
      const lines = [dryRun ? '演练结果（未写入任何文件）' : '恢复完成']
      for (const a of r.actions) lines.push(`  - ${a}`)
      if (r.warnings.length) {
        lines.push('', '提醒:')
        for (const w of r.warnings) lines.push(`  - ${w}`)
      }
      if (r.problems.length) {
        lines.push('', `包内问题 ${r.problems.length} 项（前 5）:`)
        for (const p of r.problems.slice(0, 5)) lines.push(`  - ${p}`)
      }
      if (!dryRun) {
        lines.push('', '插件完整性校验:')
        try {
          const v = verifyProfile(path.join(installDir, 'data', 'dsh-home'))
          for (const e of v.entries) {
            const mark = e.status === 'ok' ? 'OK ' : '!! '
            lines.push(`  ${mark}${e.name}  ${e.declared}${e.installed ? `  已装 ${e.installed}` : '  未安装'}`)
          }
          if (!v.ok) {
            lines.push('', '  有插件未就位：若包内不含 node_modules，请启动 DSH 让它联网重装；')
            lines.push('  或改用 includeModules=true（默认）重新打包后再还原。')
          }
        } catch (err) {
          lines.push(`  校验失败: ${err && err.message ? err.message : err}`)
        }
        lines.push('', '请完全退出并重新启动 DeepSeek Harness。')
      }
      return lines.join('\n')
    },
  }))
}
