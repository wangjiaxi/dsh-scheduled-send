# dsh-scheduled-send

在 DSH 的输入框里，把一条消息**排到将来的某个时刻**：点发送按钮左边的那个 ▾，选好日期和时间，到点由宿主把它发出去。

- 入口：输入框工具栏，紧挨着发送按钮的箭头（悬停显示「定时消息」）
- 交互照飞书：箭头 → 日期 + 时间 → `定时发送`；顺手给了 `10 分钟后 / 30 分钟后 / 1 小时后 / 明天 9:00` 四个预设
- **到点由宿主投递**：关掉标签页、切到别的会话、宿主重启，都不影响
- 待发送的条目就列在同一个对话框里，可以逐条撤销；有排队时按钮上带一个计数角标
- 投递出来的就是一条**普通的用户消息**，和你自己敲回车发出去的一样

## 安装

```sh
# 从 GitHub
dsh plugin --profile web add github:wangjiaxi/dsh-scheduled-send

# 从本地目录（开发时用，link 方式，改文件即时生效）
dsh plugin --profile web add /path/to/dsh-scheduled-send

# 从 npm（发布之后）
dsh plugin --profile web add dsh-scheduled-send@latest
```

装完刷新页面，输入框右侧就会出现那个箭头。

> 包声明了 `dsh.bundle.patch`，`dsh plugin add` 会自动把它写进 `dsh.profile.bundles`，不用手改 `cordis.patch.yml`。

## 用法

1. 在输入框里写好要发的内容（**定时发送取的是点箭头那一刻的草稿**）
2. 点发送按钮左边的 ▾
3. 选日期和时间，或者点一个预设
4. 点 `定时发送` → 输入框清空，按钮上出现计数角标

到点之后，宿主把这条消息作为用户消息投进会话；会话空闲就立刻开始这一轮，正忙就排在下一条。

## 它和自带的「定时任务」不是一回事

DSH 自带的 `schedule_*` 是**给模型的提醒**：到点投递的是一段 `[SCHEDULE REMINDER]` 提醒帧，会话里显示成「自动化任务」，模型看到的是「有条提醒」而不是「用户说了句话」。

本插件投的是**用户自己的消息**：`source.kind === 'user'`，走的是输入框回车那条宿主路径（`ctx.sessionController.prompt`），所以会话日志、界面、上下文里看到的都是一条普通的用户发言。

两者不冲突：需要「提醒模型」用 `schedule_create`，需要「替我把这句话在 9 点发出去」用这个箭头。

## 工作原理

```
┌──────────── 浏览器 ────────────┐        ┌──────────── 宿主 ────────────┐
│ 箭头 → 对话框                  │        │ 每秒扫一次队列               │
│  POST /create {sessionId,      │  ───▶  │ 到点 → sessionController     │
│    text, dueAt, timeZone}      │        │        .prompt({mode:'queue'})│
│  列表 / 撤销                   │  ◀───  │ 队列存 tasks.json            │
└────────────────────────────────┘        └──────────────────────────────┘
```

- 待发送队列落在 `$DSH_HOME/storages/dsh-scheduled-send/tasks.json`（写临时文件再 rename），插件 HMR、宿主重启后按绝对时间重建
- 投递走 `ctx.sessionController.prompt({ mode: 'queue' })` —— 会自动恢复冷会话、做附件与模型能力校验、把消息写进会话日志
- 投递失败（会话没了、宿主忙）每 60 秒重试一次，5 次之后丢弃并记一条 warning
- 时间一律以 epoch 毫秒存储，时区只在投递时作为 `clientTimeZone` 带给宿主，因此换时区不会把已排的条目挪位

## HTTP 接口

前缀 `/dsh-scheduled-send/api`（同源、走浏览器的登录 cookie），脚本和自测都能直接用：

| 方法 | 路径 | 请求 | 返回 |
| --- | --- | --- | --- |
| GET | `/info` | — | `{ ok, name, version, queued }` |
| POST | `/list` | `{ sessionId }` | `{ ok, items }` |
| POST | `/create` | `{ sessionId, text, dueAt, timeZone? }` | `{ ok, item }` |
| POST | `/cancel` | `{ id }` | `{ ok, removed }` |
| POST | `/fire` | `{ id }` | `{ ok }` — 立刻投递，自测 / 补发用 |

`dueAt` 是 epoch 毫秒，必须晚于现在、且在一年以内；`timeZone` 省略也可以。

## 限制

- **只发文本**：定时发送不带附件，输入框里有附件时会提示先去掉
- 排上之后输入框会被清空（消息已经进了队列，正文还在对话框的待发送列表里能看到）
- 依赖 `webServer` 与 `sessionController` 两个宿主服务（Web / 桌面版的标配）
- 路由没有独立的鉴权层，和宿主本身一样信任浏览器会话；不要把 `dsh web` 直接暴露到公网

## 开发与自测

```sh
node --check index.js
node --check client.js
node scripts/validate.mjs   # 等同于 npm run validate
```

`scripts/validate.mjs` 检查的是加载器真正会读的东西：manifest、bundle patch、exports、locale 元信息、图标、客户端注册 id。CI 也跑同一套（`.github/workflows/validate.yml`）。

想不等到点就看投递效果：`POST /fire { id }`。

## License

MIT

---

## English

Adds a chevron beside the composer send button. Pick a date and time, hit **Schedule**, and the **host** delivers that message into the conversation at that moment — closing the tab, switching sessions, or restarting the host does not cancel it.

- The trigger lives in `conversation.input.right`; the dialog snapshots the draft when you open it
- Delivery goes through `ctx.sessionController.prompt({ mode: 'queue' })`, so what lands in the session log is an ordinary user message (`source.kind === 'user'`), not a `[SCHEDULE REMINDER]` frame
- The queue is a JSON file under `$DSH_HOME/storages/dsh-scheduled-send/`, rebuilt on load from absolute epoch milliseconds; failures retry every 60 s, five times
- Text only — attachments are refused for now

```sh
dsh plugin --profile web add github:wangjiaxi/dsh-scheduled-send
```

HTTP surface: `GET /dsh-scheduled-send/api/info`, `POST /{list,create,cancel,fire}`.
