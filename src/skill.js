/**
 * 内置 skill：DSH 完整备份 / 迁移 / 灾难恢复的操作规范。
 * 由主机侧经 ctx.skills.register 全局注册，模型在相关请求时加载。
 */

export const SKILL_NAME = 'dsh-travel-kit'

export const SKILL_DESCRIPTION =
  '把 DSH 完整打包（对话、工作区、插件与配置、凭证、界面状态、目录联接结构）并生成报告；也可从备份包恢复，或迁移到另一台电脑。'

export const SKILL_WHEN_TO_USE =
  '用户要求备份 DSH、导出全部数据、迁移 DSH 到另一台电脑、或更新后出现"对话/工作区/插件消失、界面像刚安装"时使用。'

export const SKILL_CONTENT = `# DSH 备份 / 迁移 / 恢复规范（dsh-travel-kit）

## 什么时候用
- 用户要"备份所有东西 / 导出对话和插件 / 换电脑"
- 用户说"更新后全没了、像新装的"，需要先判断再恢复

## 先诊断，再动手
1. 调用 \`travel_status\`。重点看三件事：
   - **联接状态**：\`~/.dsh\`、\`AppData\\Roaming\\@deepseek-ai\\dsh-desktop\`、\`AppData\\Local\\dsh-dafeiyu\` 是否仍是 junction；
   - **数据目录**里会话数是否 > 0；
   - 安装目录是否和用户以为的一致。
2. 现象与判断：
   | 现象 | 结论 | 处理 |
   |---|---|---|
   | 联接变成 directory、会话数 0 | 更新把联接换掉了，数据还在 | 找到旧数据后 \`travel_restore\` |
   | 安装目录变了、新目录为空 | 更新装到别处，旧数据在原路径 | 用旧路径的包/数据恢复 |
   | 联接正常、会话也在 | 可能是别的问题，不要盲目恢复 | 继续问清现象 |

## 备份
调用 \`travel_export\`：
- 默认输出到 \`D:\\DSH-Travel\\DSH-Travel-<主机名>-<时间>\\\`
- 产出一份 \`report.md\`（给人和 agent 看）与 \`manifest.json\`（带每个文件的 SHA-256）
- 包内含 \`.credentials.yaml\`（明文），**提醒用户不要外传**
- \`node_modules\` 与 \`dsh-runtimes\` 不入包，恢复后首次启动会重装/重下载

打包后向用户汇报：路径、会话数、工作区数、大小、未包含项。

## 恢复
1. 先 \`travel_inspect\` 校验包完整（文件齐全、大小一致）。
2. 再 \`travel_restore\` 且 **\`dryRun\` 保持默认 true**，把"将要做的事"给用户看。
3. 用户确认后，提醒其**完全退出 DSH（含托盘）**，再以 \`dryRun: false\` 真正执行。
4. 恢复会把现有数据改名留存为 \`dsh-home.pre-restore-<时间>\`，不删除任何东西。
5. 完成后让用户重启 DSH；插件依赖会在启动时自动重装，首次启动较慢属正常。

**不要**在 DSH 运行期间直接覆盖数据目录而不告知用户——文件被占用时可能写到一半。

## 迁移到另一台电脑
1. 新机器先装同版本 DSH，并启动一次，让它生成 \`data\` 结构。
2. 把整个包目录拷过去（路径随意）。
3. 在新机器的 DSH 里安装 \`dsh-travel-kit\`（本地 tgz 或后续发布版），重启。
4. \`travel_inspect\` → \`travel_restore\`（如需指定 \`installDir\`）→ 重启。
5. 盘符/路径不同的情况：
   - 对话会回来，但 \`workspace.json\` 里的工作区路径仍指向旧机器，需要用户重新添加工作区；
   - 三条联接由工具按新安装目录重建，无需手工 mklink。

## 报告怎么写
\`report.md\` 已经由工具生成，包含：概况、联接结构表格、工作区、插件、包内含/未含、本机恢复步骤、跨机迁移步骤、已知边界。
如果要补充说明，直接在该文件末尾追加，不要重写整个文件。
`
