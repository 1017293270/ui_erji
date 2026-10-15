# 多家公司

> 2026-10-14 起，一台 EchoMind 服务器可以服务多家公司。

**一句话**：每家公司用自己的飞书企业自建应用接入。管理员在桌面端的「设置 → 公司管理」里填上这家公司的 App ID 和 App Secret，得到一个 6 位加入码；那家公司的人第一次登录时输入一次加入码，以后照常点「用飞书登录」。

## 加一家公司

### 1. 在那家公司的飞书开发者后台准备应用

在 open.feishu.cn/app 操作，操作的人必须是那家公司的成员：

1. 创建一个「企业自建应用」，名字可以叫 EchoMind。
2. 「添加应用能力」：添加「机器人」。声纹同意卡片由它发给同事。
3. 「权限管理 → 批量导入/导出」：粘贴权限清单（「公司管理」页上有「复制权限清单」按钮），然后申请开通。
4. 「权限管理 → 数据权限 → 通讯录权限范围」：选择全部成员，否则同事列表会不全。
5. 「安全设置 → 重定向 URL」：添加 `http://127.0.0.1:43517/feishu/callback`。
6. 「版本管理与发布」：设好可用范围，发布版本，等那家公司的管理员审核通过。不在可用范围里的人既登录不了，也收不到声纹同意卡片。

权限清单的内容如下，以 `apps/server/src/companies.ts` 里的 `APP_PERMISSIONS` 为准：

```json
{
  "scopes": {
    "tenant": [
      "tenant:tenant:readonly",
      "contact:contact.base:readonly",
      "contact:user.base:readonly",
      "contact:department.base:readonly",
      "contact:user.employee:readonly",
      "im:message:send_as_bot"
    ],
    "user": ["offline_access", "task:task:write", "calendar:calendar:read", "calendar:calendar.event:read"]
  }
}
```

`tenant:tenant:readonly` 用来读企业名称。添加公司时，服务器会用它核对这个应用属于哪家公司，所以它是必需的。`im:message:send_as_bot` 用来发声纹同意卡片。

### 2. 在 EchoMind 里添加

在「设置 → 公司管理 → 添加公司」里填 App ID 和 App Secret（在应用的「凭证与基础信息」页）。服务器会先做两件事，再保存：

- 用这组 App ID 和 Secret 向飞书核对。
- 读出企业名称，确认这家公司没有被添加过。一家公司只能对应一个应用。

保存后页面上会出现这家公司和它的加入码。

### 3. 打开卡片回调

添加以后等一分钟，服务器会和这个应用连上一条飞书长连接。然后在开发者后台：

1. 「事件与回调 → 回调配置」：订阅方式选「使用长连接接收回调」，添加回调「卡片回传交互」（card.action.trigger）。
2. 再发布一个版本。

飞书只在长连接已经连上时才允许保存这个设置，所以这一步要放在添加公司之后。不做这一步，声纹同意卡片照样能发出去，但同事点按钮时 EchoMind 收不到。

### 4. 把加入码发给那家公司的同事

加入码只是告诉 EchoMind 去哪家公司登录，不是密码：只有那家公司飞书里的人才能登录成功，泄露了也没关系。同一个地址一分钟内最多试 20 次加入码，防止有人逐个猜出客户名单。

## 10 月 15 日以前添加的公司

声纹功能上线前添加的公司（包括默认公司），要在开发者后台补三件事，再发布一个版本：

1. 「添加应用能力」里添加「机器人」。
2. 「权限管理」里开通 `im:message:send_as_bot`（以应用的身份发消息）。
3. 按上面第 3 节打开卡片回调。

## 日常管理

- **核对**：用保存的 Secret 再问一次飞书，顺便更新企业名称。
- **更换 Secret**：在飞书后台重置 App Secret 后，把新的填进来。保存前会先核对，并确认还是同一家公司。
  - Secret 不对期间，那家公司的人会看到「请管理员更换 App Secret」，但**不会被退出登录**；换好以后马上恢复。
- **停用**：那家公司的人在下一次请求时退出登录，也不能再登录；后台也不再刷新他们的飞书授权。数据不删除，重新启用后可以照常登录。管理员不能停用自己所在的公司。

## 谁是管理员

服务器 `.env` 里的 `ECHOMIND_ADMINS` 列出管理员的 open_id，多个用逗号隔开。管理员必须属于默认公司，也就是 `.env` 里 `FEISHU_APP_ID` 对应的公司。改完需要重启服务。管理员在桌面端「设置 → 飞书」里会多出「公司管理」一行；服务器对每次公司管理请求都会再查一次身份。

## 默认公司和旧版本

- `.env` 里的 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET` 对应的公司是默认公司。服务启动时会把它写进数据库，并分配加入码。
  - 写进数据库以后，以「公司管理」里保存的 Secret 为准。
  - 如果 `.env` 里的 Secret 和数据库里的不一样，日志会提醒一句。
- 加入码功能之前的桌面端登录时不带加入码，服务器会把它们当成默认公司。所以已经发出去的安装包照常能用。
- 加入码之前就登录过的人，新版桌面端会在下次检查登录状态时，从服务器记下他的公司。退出登录后再登录，不用输入加入码。

## 数据和安全

- App Secret 用 `ECHOMIND_DATA_KEY` 做 AES-256-GCM 加密，和这个 App ID 绑定。密文换到别的公司那一行解不开。
- 所有业务表都带 `tenant_id`。每次调用飞书时，都按这个人所在的公司选用那家公司的应用和凭证。
- 桌面端不保存 App Secret。管理员在「公司管理」里输入的 Secret 直接发给服务器。

## 接口

| 接口 | 说明 |
| --- | --- |
| `GET /v1/auth/feishu/config?company=<加入码>` | 这家公司的 App ID、要申请的权限、公司名称 |
| `POST /v1/auth/feishu` | 登录，请求体里的 `company` 是加入码 |
| `GET /v1/me` | 还包括 `company: { name, joinCode }` 和 `admin` |
| `GET /v1/admin/companies` | 所有公司，以及新公司要导入的权限清单 |
| `POST /v1/admin/companies` | `{ appId, appSecret }`，核对后添加 |
| `POST /v1/admin/companies/:id/check` | 核对 |
| `POST /v1/admin/companies/:id/secret` | `{ appSecret }`，核对后更换 |
| `POST /v1/admin/companies/:id/disable`、`/enable` | 停用、启用 |

公司相关的错误码：

- `company_required`、`unknown_company`、`company_disabled`：加入码相关。
- `company_exists`：这家公司已经添加过。
- `app_rejected`：App ID 或 App Secret 不对。
- `app_unavailable`：应用没发布或已停用。
- `app_scope_missing`：缺少 `tenant:tenant:readonly` 权限。
- `own_company`：管理员不能停用自己所在的公司。
- `forbidden`：不是管理员。
