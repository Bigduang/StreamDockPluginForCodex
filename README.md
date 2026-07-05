# StreamDockPluginForCodex

Stream Dock 上的 Codex 会话监听插件。它可以把一个按钮绑定到指定的 Codex `threadId`，并在按钮上显示会话标题、当前状态和小机器人动画。

## 适用产品和兼容性

这个插件面向 **MiraBox / HotSpot Stream Dock 生态**，通过 Stream Dock 桌面软件加载。它不是独立运行的桌面程序，也不是通用 Stream Deck 插件。

适用范围：

- 适用于 Stream Dock 软件中可添加普通按键动作的设备。
- 插件动作只声明 `Controllers: ["Keypad"]`，也就是普通按键 / LCD 按键位。
- 已在当前开发环境的 `MBox-N4`、`StreamDock[293S]` 类型设备上验证基本加载和按钮刷新。
- 同一 Stream Dock 软件生态下暴露 `Keypad` 按键位的设备可重点尝试，例如 293S、293V3、N4 / N4 Pro、N3、MiniW、N1、带 Stream Dock 功能的键盘等。实际可用性取决于设备在 Stream Dock 软件中是否以按键网格方式出现。

不适用或暂不支持：

- 不支持旋钮 / 编码器交互。本项目没有实现 `Knob` 控制器，也不处理 `dialDown`、`dialUp`、`dialRotate` 事件。
- 不支持只作为信息屏或副屏显示的动作位。本项目没有实现 `Information` 或 `SecondaryScreen` 控制器。
- 当前主要面向 Windows。`manifest.json` 只声明了 Windows，且按键聚焦 Codex 窗口的逻辑使用 Windows API。
- 不适用于 Elgato Stream Deck 官方软件。虽然概念接近，但本项目按 Stream Dock SDK 和目录结构开发。

软件版本要求：

- Windows 10 或更高版本。
- Stream Dock `3.10.188.226` 或更高版本。
- 插件入口使用 Stream Dock 内置 Node.js 20；Windows 下需要 Stream Dock `3.10.188.226+` 才有对应内置 Node 支持。

相关依据：

- Stream Dock SDK 的 `manifest.json` 中 `Controllers` 可声明 `Keypad`、`Information`、`SecondaryScreen`、`Knob`；其中 `Keypad` 对应普通按钮。参考：[Stream Dock SDK 清单文档](https://sdk.key123.vip/guide/manifest.html)。
- 本项目的 `manifest.json` 明确只声明 `"Controllers": ["Keypad"]`。
- MiraBox 官网展示了 Stream Dock、Keyboard with Screen、Universal Screen 等产品线，插件实际只覆盖其中带普通按键位的 Stream Dock / Keyboard with Screen 场景。参考：[MiraBox 官网](https://mirabox.net/)。

## 功能

- 手动输入 `threadId` 监听 Codex 会话。
- 支持本机 Codex app-server。
- 支持通过 SSH 连接远程机器上的 Codex app-server。
- 支持密码或 SSH key 认证。
- 按钮按下后尝试切换到 Codex 桌面窗口。
- 黑底白字按钮风格，顶部显示标题，底部显示状态动画。
- 中文状态显示：同步、空闲、进行中、忙碌、待批、输入、离线、丢失、错误。

## 目录和路径

这类 Stream Dock 插件要特别注意“源码目录”和“实际加载目录”不是一回事。

源码仓库可以放在任意目录。例如当前开发目录是：

```powershell
C:\Users\<你>\AppData\Roaming\HotSpot\StreamDock\CodexHook
```

Stream Dock 实际加载插件时，需要插件目录位于：

```powershell
%APPDATA%\HotSpot\StreamDock\plugins\com.vvvvv.streamdock.codexhook.sdPlugin
```

也就是完整路径通常是：

```powershell
C:\Users\<你>\AppData\Roaming\HotSpot\StreamDock\plugins\com.vvvvv.streamdock.codexhook.sdPlugin
```

`manifest.json` 必须在这个 `.sdPlugin` 目录的根部。不要把仓库目录名随意放到 `plugins` 下让 Stream Dock 加载，除非目录名就是 `com.vvvvv.streamdock.codexhook.sdPlugin` 且内部结构完整。

## 环境要求

- Python 3.12。可以使用 Conda、venv 或系统 Python，不要求固定环境名或固定安装路径。

```powershell
python --version
```

- Python 依赖：

```powershell
python -m pip install pillow paramiko
```

- 如果 Stream Dock 运行时找不到正确的 Python 解释器，可以在启动 Stream Dock 前设置 `CODEXHOOK_PYTHON` 指向你的解释器路径。

```powershell
$env:CODEXHOOK_PYTHON = "C:\Path\To\Python312\python.exe"
```

- Node.js / npm，用于安装 `ws` 依赖。Stream Dock 运行时会使用自带 Node 执行插件入口。

## 开发安装

1. 克隆仓库到源码目录。

```powershell
git clone git@github.com:Bigduang/StreamDockPluginForCodex.git CodexHook
cd CodexHook
```

2. 安装 Node 依赖。

```powershell
npm install
```

3. 确认 Python 后端可以编译。

```powershell
python -m py_compile .\python\backend.py
```

4. 部署到 Stream Dock 插件目录。

```powershell
npm run deploy
```

部署脚本会把必要文件复制到：

```powershell
%APPDATA%\HotSpot\StreamDock\plugins\com.vvvvv.streamdock.codexhook.sdPlugin
```

首次安装或重部署后，建议重启 Stream Dock。

## 打包说明

用于分发时，最终插件目录必须命名为：

```text
com.vvvvv.streamdock.codexhook.sdPlugin
```

目录内至少应包含：

```text
manifest.json
package.json
package-lock.json
node_modules/
plugin/
propertyInspector/
python/
static/
```

也就是说，打包对象是 `com.vvvvv.streamdock.codexhook.sdPlugin` 这个目录本身，而不是源码仓库外层目录。源码目录中的 `logs/`、`__pycache__/`、`.git/` 不应进入分发包。

当前 `scripts/deploy.ps1` 会从源码目录复制这些必要内容到 Stream Dock 的 live 插件目录。发布前需要先运行 `npm install`，否则 `node_modules/ws` 不存在，插件入口无法连接 Stream Dock WebSocket。

## 使用方式

1. 在 Stream Dock 管理界面添加“CodexHook 会话监听”按钮。
2. 选中按钮，在属性面板输入 `threadId`。
3. 可选：自定义按钮顶部标题。留空时使用 Codex 读出的会话标题。
4. 连接来源选择：

```text
本机 Codex
SSH 远程 Codex
```

5. SSH 模式下填写主机、端口、用户名、认证方式和远端 codex 命令。

远端 codex 命令可以留空使用 `codex`。如果远端非交互 shell 找不到 `codex`，填写绝对路径，例如：

```bash
/home/user/.nvm/versions/node/v22.22.1/bin/codex
```

## 安全说明

- SSH 密码和私钥口令保存在 Stream Dock 本地按钮配置中，不会写入源码仓库。
- `.gitignore` 已排除日志、缓存、环境变量文件和常见私钥文件。
- 提交前建议运行：

```powershell
rg -n "password|token|secret|BEGIN .*PRIVATE KEY|sshPassword" . -g "!node_modules/**" -g "!logs/**"
```

## 开发命令

```powershell
npm install
npm run deploy
python -m py_compile .\python\backend.py
node --check .\propertyInspector\index.js
```

## 项目结构

```text
manifest.json                  Stream Dock 插件清单
plugin/index.js                 Node 入口，负责连接 Stream Dock 并启动 Python 后端
python/backend.py               Codex app-server 监听、按钮渲染和窗口聚焦逻辑
propertyInspector/              按钮配置面板
static/                         插件图标和动画素材
scripts/deploy.ps1              部署到 Stream Dock live 插件目录
```
