# FC 在线模拟器

一个可直接静态部署的 FC / NES 浏览器模拟器页面。模拟器核心来自 GitHub 项目 [bfirsh/jsnes](https://github.com/bfirsh/jsnes)，当前已将 `jsnes.min.js` vendoring 到 `vendor/`，上线时不依赖 CDN。

## 功能

- 上传本地 `.nes` ROM 后直接运行
- 内置 4 个合法公开 ROM，可在手机上一键开玩
- 双手机同步房间：1P 创建房间，2P 输入房间码加入
- 支持 1P / 2P 键盘、触屏虚拟手柄、标准浏览器 Gamepad
- 运行 / 暂停、重置、静音、全屏
- 每个 ROM 独立保存 / 读取即时状态
- 单机遇到 jsnes 不支持的 NES Mapper 时，会自动切到本地内置的 EmulatorJS / fceumm 兼容核心
- 纯静态文件，可部署到 GitHub Pages、Cloudflare Pages、Vercel、Nginx 等静态空间

## 本地运行

```bash
python3 -m http.server 8080
```

然后打开：

```text
http://localhost:8080/fc-online-emulator/
```

手机和电脑在同一 Wi-Fi 下时，把服务绑定到局域网：

```bash
python3 -m http.server 8080 --bind 0.0.0.0
```

然后在手机浏览器打开电脑的局域网地址：

```text
http://你的电脑IP:8080/fc-online-emulator/
```

## 双手机同步

双手机同步需要 WebSocket 服务，使用项目内置的 Node 服务：

```bash
node fc-online-emulator/sync-server.js --host 0.0.0.0 --port 8081
```

手机和电脑在同一 Wi-Fi 下时，两个手机都打开：

```text
http://你的电脑IP:8081/fc-online-emulator/
```

第一台手机点“创建房间”，第二台手机输入房间码点“加入”。进入房间后，1P 或 2P 任意一台手机都可以点内置游戏或用“载入 ROM”上传 `.nes` 文件；同步服务会把 ROM 广播给另一台手机，两边加载完成后自动同步开始。

公网在线版如果只单机游玩，可以直接把整个 `fc-online-emulator/` 目录上传到 GitHub Pages、Cloudflare Pages、Vercel 或任意静态空间。双手机同步需要把 `sync-server.js` 部署到支持 Node/WebSocket 的服务器。

## ROM 兼容性

默认模拟核心是 `jsnes`，用于单机和双手机同步。它支持常见 Mapper，例如 `0/1/2/3/4/5/7/11/34/38/66/94/140/180`。

部分中文卡、学习卡、外星科技、南晶科技 ROM 会使用特殊 Mapper，例如 `163/74/241/176/199`。这些 ROM 在单机上传时会自动切到 `EmulatorJS / fceumm` 兼容核心打开。兼容核心暂时不接入当前房间同步逻辑，所以这类 ROM 目前只能单机玩。

## 键位

| 玩家 | 方向 | B / A | Select / Start |
| --- | --- | --- | --- |
| 1P | WASD | J / K | U / I |
| 2P | 方向键 | N / M | , / . |

2P 也支持小键盘：`8/4/5/6` 方向，`1/2` 为 B/A，`0/Enter` 为 Select/Start。

## ROM

项目不内置商业 ROM。`roms/` 里只放合法公开的 homebrew / test ROM；你也可以上传自己合法拥有或有授权的 `.nes` 文件。
