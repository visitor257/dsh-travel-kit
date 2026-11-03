# dsh-travel-kit

把一台机器上的 DeepSeek Harness **完整打包**（对话、工作区、插件与配置、凭证、界面状态、目录联接结构），生成一份可读报告；也可从包恢复，或迁移到另一台电脑。

## 为什么需要它

DSH 把数据放在 `<安装目录>\data\dsh-home`，并依赖三条目录联接把"程序默认会找的位置"指过去：

```
~/.dsh                                         -> <安装>\data\dsh-home
%APPDATA%\@deepseek-ai\dsh-desktop             -> <安装>\data\electron-userdata
%LOCALAPPDATA%\dsh-dafeiyu                     -> <安装>\data\dafeiyu-runtime
```

更新一旦把某条联接换成空目录、或把程序装到新路径，程序就会用一套空状态启动——界面、向导、插件全像刚装，而数据其实还在。本插件把"结构"本身也写进报告，所以恢复时不只知道文件在哪，还知道它们该怎么指。

## 工具

| 工具 | 作用 |
|---|---|
| `travel_status` | 查看安装/数据路径、三条联接状态、工作区与插件清单 |
| `travel_export` | 打包 + 生成 `report.md` 与带 SHA-256 的 `manifest.json` |
| `travel_inspect` | 校验包完整性（文件齐全、大小一致） |
| `travel_restore` | 从包恢复并重建联接（默认 dryRun，不落盘） |

配套 skill `dsh-travel-kit` 会告诉模型：先诊断再动手、恢复前先 dryRun、恢复后必须重启。

## 包结构

```
DSH-Travel-<主机>-<时间>/
  report.md            人/agent 可读的完整说明
  manifest.json        文件清单 + 哈希 + 统计
  data/dsh-home/       对话、工作区、profile 配置、插件启用状态、凭证
  data/electron-userdata/  窗口与本地存储
  layout/layout.json   安装路径、联接映射、环境变量
  layout/plugins.json  插件清单
  layout/workspaces.json 工作区清单
```

不打包：`node_modules`（按 `package.json` 重装）、`dsh-runtimes`（按需下载）。

## 安全

- 包内含明文 `.credentials.yaml`，不要外传；可用 `travel_export` 的 `includeCredentials: false` 排除。
- 恢复会把现有数据改名留存为 `dsh-home.pre-restore-<时间>`，不删除任何东西。

## 安装

```
dsh plugin --profile desktop add <本包>.tgz
```

安装后重启 DSH 生效。
