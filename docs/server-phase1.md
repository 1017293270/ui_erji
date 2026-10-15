# 服务端第 1 期任务说明

> 状态：草稿，等确认后开工。写于 2026-10-14。
> 依据：已确认的服务端方案（腾讯云、Node + TypeScript、PostgreSQL、长连接、无域名）和第 0 期清单。

## 0. 目标和验收

**一句话**：会上确认的待办，由服务端建成飞书任务；每天早上机器人私聊每个人「本周几项、完成几项」，回复编号就算完成；领导随时能看到每周安排了几件、完成了几件。**记录人的电脑关机，这一切照常运转。**

验收时按这个顺序走一遍（测试同事 A、你当记录人和领导）：

1. 你录一场会，确认 3 条待办：一条给 A，一条给自己，一条外部的。点「确认并推送」后 30 秒内，飞书里出现 3 个任务：A 是负责人；你自己是负责人；外部那条标题带「跟进：」，负责人是你。
2. 你的 Mac 关机。第二天 09:00，A 和你各收到一条机器人私聊，内容是本周的清单。
3. A 回复「1」。机器人回「已完成」，1 分钟内飞书任务变成已完成。你给机器人发「进度」，看到本周 1/3。
4. A 在飞书任务里把它改回未完成。15 分钟内服务端跟上，A 第二天的消息也对得上。
5. A 不回消息，直接在飞书任务里点完成另一项（如果有的话），同样算完成。
6. 周一 09:00，你收到上周的周报：安排几件、完成几件、按人分的明细。
7. 拆开桌面端的安装包，搜不到飞书 App Secret 和 DeepSeek key。
8. 用昨晚的备份恢复出一份数据库，条数对得上。

## 1. 做什么、不做什么

**第 1 期做：**

- 服务端（新目录 `apps/server`）：
  - 飞书登录换 token；
  - 读通讯录、读日历参会人；
  - DeepSeek 代理；
  - 接收发布的会议和待办，建飞书任务；
  - 每日私聊、回复编号确认、撤销；
  - 飞书任务状态双向同步；
  - 领导周报和「进度」查询；
  - 备份和告警。
- 桌面端：所有飞书和 DeepSeek 调用改走服务端；推送改为「发布」；从服务端拉任务状态；团队页改用服务端数据。

**第 1 期不做（放第 2 期以后）：**

- 消息卡片和按钮（延期、有阻碍）；
- 飞书工作台里的领导网页（原因见第 2 节）；
- 第二家公司、商店应用；
- 上传纪要正文；
- 在桌面端修改已发布的待办（改标题、换负责人）——第 1 期在飞书任务里改；
- 节假日和调休；
- 声纹。

## 2. 跟已定方案相比，有 3 处调整（需要你点头）

1. **领导看板先不放飞书工作台，改成机器人消息加桌面端团队页。**
   - 原因：
     - 我们现在用 IP 和自签证书，飞书内置浏览器不认自签证书，打开会报证书错误。
     - 改用 http，领导的登录凭证会明文传输。
     - 正规证书要先有域名。
   - 第 1 期领导这样看：
     - 每周一早上收到上周周报；
     - 随时给机器人发「进度」查本周；
     - 装了桌面端的领导，在「团队」页看明细。
   - 有了域名，再做工作台网页。
2. **飞书任务描述里不再带「会上原话」。**
   - 原因：原话属于逐字稿。我们定的规则是逐字稿不上服务端，所以发布时只带待办本身。
   - 现在的描述：说明、对方、来自哪场会、由 EchoMind 整理。
3. **「同事在飞书任务里点完成」先用定时查询实现，任务事件订阅等第 0 期验证后再加。**
   - 做法：服务端每 15 分钟查一次进行中的任务，发每日消息前再查一次。
   - 好处：查询简单可靠；事件订阅要记录人用自己的身份逐个订阅，还没验证过。
   - 等事件验证通过，再加上作为提速手段；定时查询一直保留，兜底防止漏事件。

## 3. 整体结构

```
桌面端（Mac）                                 echomind-server（58.87.77.127，北京）
┌────────────────────────┐   HTTPS :8443     ┌──────────────────────────────────────────┐
│ 录音 · 本机转写 · 纪要 │  只信任 EchoMind  │ api     Hono；登录、通讯录、日历、        │
│ 确认待办 → 发布        │ ───自签根证书───▶ │         DeepSeek 代理、发布、拉状态       │
│ （逐字稿不出电脑）     │                   │ worker  飞书长连接（收私聊）、任务队列、  │
└────────────────────────┘                   │         每日消息、状态同步、周报、备份    │
                                             │ postgres 18（只在内部网络，不对外）       │
                                             └───────────────┬──────────────────────────┘
                                                             │ 主动连出（长连接、API）
                                                             ▼
                                                   飞书开放平台 · DeepSeek
```

- **一份代码、一个镜像、两个服务**：api 和 worker 用 Docker Compose 跑，数据库是第三个容器。
  - 长连接只放在 worker 里，只开一条。飞书有多条连接时，事件会随机发给其中一条。
- **任务队列放在 PostgreSQL 里**：表 `jobs`，用 `FOR UPDATE SKIP LOCKED` 领取，不引入 Redis。
  - 每个待办都有唯一键，重启后会补做，不会重做。
- **时间**：一律按 Asia/Shanghai 计算。「周」从周一 00:00 到周日 24:00。

## 4. 每个人看到什么

### 记录人（桌面端）

- 点「确认并推送」：
  - 桌面端把会议基本信息和确认过的待办发给服务端，马上返回；
  - 界面显示「已提交，正在建飞书任务」，几秒内变成「已推送」；
  - 建任务失败时，那一条显示原因，服务端会自动重试。
- 待办列表的状态会跟着服务端走：同事回复了数字、在飞书点了完成，桌面端都会变成已完成。
  - 启动时拉一次，之后每 5 分钟拉一次。

### 同事（只用飞书，不装桌面端）

每个工作日 09:00，只有本周有任务、或者以前还有没做完的任务时，才会收到消息：

```
早上好，王小明。本周会上给你安排了 3 项，已完成 1 项：
✓ 1. 提交报价单（已完成）
  2. 确认二期排期 · 周三截止
  3. 整理客户反馈 · 来自「产品周会」

之前还没做完的：
  4. 更新部署文档 · 上周五截止，已逾期

做完了直接回复编号，比如「2」；几项一起做完就回「2 3」。回复「撤销 2」可以改回未完成，回复「清单」再看一遍。
```

回复的处理：

| 回复 | 机器人怎么回 |
| --- | --- |
| `2` / `2 3` / `2、3` / `第2项` | 「好的，「确认二期排期」已完成。本周 2/3。」 |
| `撤销 2` | 「已改回未完成：确认二期排期。」 |
| `清单`、`任务` | 重发一遍当前清单 |
| 已经完成的编号 | 「这项之前已经完成了。」不重复操作 |
| 没有这个编号 | 「本周没有第 7 项，你的编号是 1–4。」 |
| 其它文字 | 简短说明用法（每天最多提示一次，避免刷屏） |

- **编号固定**：每个人每周一套编号，按任务发布的顺序排，完成了也不换号，新任务往后追加。
  - 上周没做完的，在本周第一条消息里接着往后编号。
- **用哪一周的编号**：
  - 如果是对某条提醒点了「回复」，就按那条提醒的编号；
  - 直接发数字的，按最近一条提醒的编号。
  - 所以周一早上消息还没发之前回「2」，指的是上周那条。
- **外部待办**：变成记录人自己的「跟进：…」任务，出现在记录人的清单里，用同样方式回复完成。

### 领导（第 1 期就是你）

- **每周一 09:00，收到上周周报**：

  ```
  上周（10/12–10/18）周会共安排 12 件，完成 9 件（75%）。
  按人：王小明 3/3 · 李雷 2/4（逾期 1）· 韩梅梅 4/5
  外部跟进 3 件，完成 2 件。
  回复「进度」看本周。
  ```

- **随时发「进度」**：返回本周到目前为止的同样统计。
- **统计口径**（第 1 期就固定下来）：
  - 「安排」：计划周等于这一周的已发布任务。计划周取会议日期所在的周。延期的任务不移出原来那一周；取消的不算。
  - 「完成」：分两个数——周日 24:00 那一刻已完成的（写进周报），和现在已完成的（包括跨周补完的）。
- **谁能看**：由管理员指定，不按职称推断。
  - 第 1 期在服务器上用一条命令授权，例如 `docker compose exec api node dist/cli.js viewer add <姓名或open_id> --all`。
  - 第 2 期再做界面。
  - 第 1 期只支持「看全公司」一种范围；按部门看的数据结构先留好。

## 5. 数据表（PostgreSQL）

所有业务表都带 `tenant_id`，唯一键也带上它。第 1 期只有一个租户，但不留以后返工的坑。

| 表 | 主要字段 | 说明 |
| --- | --- | --- |
| `tenants` | id, name, feishu_tenant_key, timezone, digest_time | 一行：你们公司 |
| `people` | id(uuid), tenant_id, open_id, name, department, active | 每天从通讯录同步；离职置为 inactive |
| `feishu_grants` | person_id, access_token_enc, refresh_token_enc, expires_at, refresh_expires_at, scopes, revoked_at | 用户 token，AES-256-GCM 加密，密钥在环境变量 |
| `sessions` | id, person_id, token_hash, device, created_at, last_used_at, expires_at, revoked_at | 桌面端登录；只存哈希，可以吊销 |
| `meetings` | id, tenant_id, recorder_id, local_id, title, started_at, duration_ms, source, planned_week, published_at | 唯一键 (recorder_id, local_id) |
| `tasks` | id(uuid), meeting_id, local_id, title, detail, owner_id, external, external_name, due, planned_week, status(open/done/cancelled), completed_at, completed_via(reply/feishu/desktop), feishu_guid, feishu_url, feishu_state(pending/created/failed), version, updated_at | 唯一键 (meeting_id, local_id) |
| `task_events` | task_id, at, actor_id, source, from_status, to_status | 每次状态变化的流水，用来对账和撤销 |
| `week_numbers` | person_id, week, no, task_id | 每人每周的编号；(person_id, week, no) 和 (person_id, week, task_id) 各自唯一 |
| `week_snapshots` | tenant_id, week, task_id, done_at_close | 周日 24:00 的完成快照，周报用 |
| `messages` | person_id, kind(daily/weekly/reply), week, sent_on, feishu_message_id, status, body | 唯一键 (person_id, kind, sent_on)，保证一天只发一次 |
| `inbound` | feishu_message_id(pk), received_at, handled_at | 收到的私聊按 message_id 去重 |
| `jobs` | id, kind, key, payload, run_at, attempts, locked_until, last_error, done_at | 唯一键 (kind, key)，失败按 1/5/30 分钟、2 小时退避，超过 24 小时报警 |
| `viewers` | person_id, scope | 谁能看统计 |

- **数据库访问**：迁移用编号的 `.sql` 文件，配一个十几行的执行器；访问库用 `postgres`（postgres.js）。不引入 ORM。

## 6. 桌面端 ↔ 服务端接口

**基础约定：**

- 地址 `https://58.87.77.127:8443/v1/…`，JSON 用 camelCase。
- 身份：请求头 `Authorization: Bearer <EchoMind 会话>`。
- 错误：返回 `{ error: { code, message } }`，`message` 是一句告诉用户怎么办的中文，和桌面端现有习惯一致。

| 接口 | 说明 |
| --- | --- |
| `GET /v1/auth/feishu/config?company=<加入码>` | 这家公司的 App ID 和要申请的权限（2026-10-14 起按公司区分，见 `docs/companies.md`） |
| `POST /v1/auth/feishu` | 见下方「登录」；带上加入码 `company` |
| `POST /v1/auth/logout` | 吊销当前会话 |
| `GET /v1/me` | 当前用户、缺哪些权限、所在公司、是不是管理员 |
| `/v1/admin/companies…` | 公司管理，见 `docs/companies.md` |
| `GET /v1/directory` | 通讯录 `Person[]`，服务端缓存 12 小时，跟现在的 `feishu_directory` 返回值一样 |
| `GET /v1/calendar/attendees?start&end` | 跟现在的 `feishu_meeting_attendees` 一样，用记录人的 token 查 |
| `POST /v1/llm/chat` | DeepSeek 代理 |
| `POST /v1/meetings/publish` | 见下方「发布」 |
| `GET /v1/tasks/changes?since=<游标>` | 我发布的和我负责的任务里，游标之后有变化的 |
| `GET /v1/team?week=2026-W42` | 领导统计；没权限返回 403 |

**登录：**

- 桌面端仍然在本机 `127.0.0.1:43517` 接收飞书回调，所以飞书后台的重定向地址不用改。
- 拿到 `code` 后，把 `code`、`codeVerifier`、`redirectUri` 发给服务端。
- 服务端用 App Secret 换 token，并检查 `tenant_key` 是否是已开通的租户，然后：
  - 加密保存用户 token；
  - 签发 EchoMind 自己的会话，有效期 30 天，用了就顺延。
- 桌面端把会话存在 0600 权限的文件里，第 2 期再换成系统钥匙串。
- 服务端每天刷新一次用户 token，记录人不开电脑，token 也不会过期。

**DeepSeek 代理：**

- 只允许配置里的模型，请求体最大 2 MB，每人每分钟最多 30 次。
- 正文不写日志，只记长度、耗时和 token 用量。
- 返回值格式跟现在的 `llm_chat` 一样（`{ status, body }`），纪要引擎不用改。

**发布**（只有这些字段，用 zod 严格校验，多一个字段也拒收）：

```ts
{
  operationId: string,              // uuid; the same id is accepted again and returns the same result
  meeting: { localId, title, startedAt, durationMs, source, participantOpenIds: string[] },
  todos: [{ localId, title, detail?, ownerOpenId: string | null, external: boolean, externalName?, due?: "YYYY-MM-DD" }]
}
```

- **处理顺序**：服务端在同一个事务里写会议、写任务、排「建飞书任务」的队列，然后立刻返回每条任务的服务端 ID 和状态 `pending`。
- **再次发布同一场会**：只追加新的 `localId`。已有的不改；会议里少了某条，也不当作删除。
- **建飞书任务**：用记录人的身份建，`client_token` 就是任务的 UUID。
  - 同时把 UUID 写进任务的自定义字段 `extra`。
  - 飞书只在 5 分钟内按 `client_token` 去重。所以重试时如果超过 5 分钟、结果还不确定，先去飞书核对有没有带这个 UUID 的任务。
  - 核对不了，就标成「需要人工确认」并告警，绝不盲目重建。
  - 怎么核对，第 0 期一起验证。

## 7. 飞书侧

- **权限**（第 0 期在后台开）：
  - 已有：`task:task:write`、`calendar:calendar:read`、`calendar:calendar.event:read`、`offline_access`；
  - 新增：`im:message:send_as_bot`、`im:message.p2p_msg:readonly`、`task:task:read`；
  - 建议加：`contact:user.employee:readonly`（读部门和职位）。
- **事件**：长连接模式，订阅 `im.message.receive_v1`。
  - 只处理单聊里的文本。
  - 发消息的人必须是本租户、在通讯录里、而且在职。
- **SDK**：`@larksuiteoapi/node-sdk`，用它的长连接客户端和应用 token 缓存。用户 token 的调用用我们自己存的 token。
- **限流**：
  - 发消息全局 50 次/秒，同一个人 5 次/秒；任务接口 10 次/秒。
  - worker 按接口排队发送，遇到限流就退避。早上的提醒按人排队，100 人大约 2 秒内发完。
- **记录人授权失效**（离职、撤销授权）：暂停这个人发起的任务写入，不悄悄换成机器人身份。
  - 机器人私聊记录人：「需要重新登录 EchoMind 才能继续同步任务」。
  - 桌面端也显示同样的提示。
- **飞书任务和本地的冲突**：已关联的任务，以飞书的完成状态为准。
  - 回复数字时，先在本地记完成，再排队去飞书标记完成。
  - 飞书那边还没同步上之前，定时查询不会把它改回去。

## 8. 桌面端改动

- **新模块** `src-tauri/src/server.rs`：
  - 专用的 HTTPS 客户端，只信任打包进去的 EchoMind 根证书，不信任系统证书——等于固定证书；
  - 管理会话文件 `server-session.json`。
- **配置**：
  - 开发时：`.env.local` 里的 `ECHOMIND_SERVER_URL`、`ECHOMIND_SERVER_CA`。
  - 发布版：服务端地址和根证书编译进程序，不再需要也不再读取 `FEISHU_APP_SECRET`、`DEEPSEEK_API_KEY`。
  - 开发时如果没配服务端，还按现在的方式直连。等第 1 期验收后删掉直连代码。
- **命令变化**：
  - `feishu_login`：本机收到 `code` 后交给服务端换，不再用 App Secret。
  - `feishu_directory`、`feishu_meeting_attendees`、`llm_chat`：网页层的调用方式不变，Rust 改为转发给服务端。
  - `feishu_create_task` 换成 `server_publish`；`push.ts` 改为拼发布结构，不再拼原话。
  - 新增 `server_task_changes`：store 用它把服务端状态合并进本地待办（`pushed` → `done`，带上飞书链接）。
- **页面**：
  - 团队页：是领导的，用 `GET /v1/team`；不是的，只看自己发布的。
  - 设置页：显示服务端连接状态。
- **文档**：更新 `docs/desktop-ipc.md`。

## 9. 部署和运维

- **目录**：服务器上 `/srv/echomind/`，属于 ubuntu 用户：
  - `compose.yaml`；
  - `.env`：0600 权限，放 App ID/Secret、DeepSeek key、数据加密密钥、数据库密码；
  - `certs/`、`backups/`。
- **证书**：
  - 生成一个 EchoMind 专用根证书（10 年），根证书私钥不留在服务器上，放你的 Mac。
  - 用它签发服务器证书（2 年，写明 IP 58.87.77.127）。
  - 以后换服务器证书，不用重新发桌面端。
- **端口**：只对外开 8443，需要你在腾讯云安全组里放行 TCP 8443。数据库不对外。
- **部署**：
  - 代码在私有仓库 `1017293270/listening`。服务器用只读的 deploy key，把代码拉到 `/srv/echomind/src`，然后在服务器上构建镜像。
  - 部署命令是 `bash apps/server/deploy/deploy.sh`：先确认本地改动都已提交并推送，再让服务器拉代码，然后运行 `update.sh`（构建、重启、检查 `/healthz`）。
  - 启动时自动跑数据库迁移；api 和 worker 同时启动也只迁移一次。
- **密钥上服务器**：用脚本把 `apps/desktop/.env.local` 里那几项直接写进服务器的 `.env`，过程中不显示内容。**这一步执行前会先问你。**
- **备份**：
  - 每晚 03:00 `pg_dump` 压缩到 `backups/`，保留 14 天。
  - 有了腾讯云 COS 桶以后，再加一份异地备份。
  - 每月做一次恢复演练，步骤写进文档。
- **告警**：机器人私聊管理员（你），只在出问题时发：
  - 早上的提醒有人没发出去；
  - 队列里有任务卡住超过 1 小时；
  - 有人的飞书授权失效；
  - 备份失败；
  - worker 超过 5 分钟没心跳。
- **健康检查**：`GET /healthz` 返回数据库、长连接、最近一次心跳的状态。
- **文档**：新写 `docs/server.md`，包括怎么部署、怎么看日志、怎么授权领导、怎么恢复备份、怎么换证书。

## 10. 测试

- **单元测试**（vitest）：
  - 回复解析：各种数字写法、撤销、全角数字、「第2项」；
  - 编号分配和跨周接续；
  - 周的计算；
  - 消息文案；
  - 周报口径。
- **集成测试**：起一个临时 PostgreSQL 容器，覆盖：
  - 同一个 `operationId` 发布两次；
  - 两个 worker 抢同一个队列任务；
  - 同一条私聊收到两次；
  - 发到一半重启；
  - token 刷新并发。
  - 飞书接口用本地假服务器模拟，跟桌面端 Rust 测试的做法一样。
- **桌面端**：Rust 测试覆盖证书固定（不信任别的证书）和转发；现有 156 个引擎测试和 28 个 Rust 测试保持通过。
- **真实飞书联调**：只用你和测试同事两个账号。**每次发真实消息、建真实任务前都先问你。**

## 11. 开发顺序（每一步都能单独验收）

1. **骨架上线**：
   - `apps/server`、数据库迁移、证书、Compose、部署脚本；
   - `/healthz` 能从你的 Mac 通过 8443 访问。
2. **登录和代理**：
   - 登录、会话、通讯录、日历、DeepSeek 代理；
   - 桌面端切到服务端以后，现有功能照常用。
3. **发布和建任务**：
   - 发布接口、建任务队列、状态拉取；
   - 桌面端「确认并推送」走服务端。
4. **机器人**：
   - 长连接、每日消息、回复确认、撤销；
   - 飞书完成状态双向同步。
5. **领导**：领导授权命令、周报、「进度」、团队页。
6. **收尾**：备份、告警、文档，然后按第 0 节逐条验收。

全程我自己写，不派给 Codex。每一步做完先跑测试和类型检查、部署到服务器，再告诉你结果。

## 12. 需要你做的事

| 什么时候 | 事情 |
| --- | --- |
| 现在 | 看这份说明，第 2 节的 3 处调整没意见就开工 |
| 第 1 步之前 | 腾讯云控制台 → 安全组 → 放行 TCP 8443（来源 0.0.0.0/0） |
| 第 2 步之前 | 同意把 `.env.local` 里的密钥搬到服务器（我用脚本搬，不显示内容） |
| 第 4 步之前 | 飞书后台：加机器人能力、开 3 个新权限、可用范围加上测试同事、发布版本；告诉我测试同事是谁 |
| 第 4 步时 | worker 连上以后，到飞书后台「事件与回调」选「使用长连接接收事件」，添加 `im.message.receive_v1`，再发布一次版本 |
| 每次联调 | 我发真实消息或建真实任务之前问你，你回个「好」 |
