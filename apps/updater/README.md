# 更新通道（Cloudflare Worker）

部署在 `https://mojuan.fengw.site`，给两个客户端与源文档作者用。

- 桌面端 `tauri-plugin-updater` 的 `plugins.updater.endpoints` 指向 `/latest.json`。
- Android 端（`src-tauri` 的 ota 模块）的 `plugins.mojuan-update.endpoint` 指向 `/android.json`。
- 漫画源的文档（`fw6/cimoc-sources`）把 `$schema` 指向 `/schema.json`，编辑器据此补全与校验。

## 四个出口

| 路径 | 作用 |
| --- | --- |
| `GET /latest.json` | 桌面端最新已发布版本的更新清单；没有可发布版本时回 204 |
| `GET /android.json` | Android 端的清单：版本 + APK 的 sha256 + APK 下载地址；同上回 204 |
| `GET /dl/<tag>/<文件名>` | 该版本制品的下载代理，转发 `Range` |
| `GET /schema.json` | 源文档的 JSON Schema（不经 GitHub，也不需要凭据） |

`schema.json` 是随仓库入的产物，由应用的 Rust 结构体生成（见 `docs/agents/mojuan-core.md` 的
「源文档与源运行时」）：改了文档格式就重新生成，拷到这里与源仓库的根目录，再部署。测试里有
一条断言守着「出口给出的」与「仓库里那份」一致。

`android.json` 的内容是 release 里的 `android.json` 资产（由 `release.yml` 的 Android 作业生成）：

```json
{ "version": "1.5.0", "url": "mojuan-1.5.0-android.apk", "sha256": "<APK 的 sha256>" }
```

Worker 只把 `url` 换成自己的 `/dl` 路径，`version` 与 `sha256` 原样透传——客户端按
`version` 判断有没有新版、按 `sha256` 确认下载到的内容完整。签名是另一层：Android 在
覆盖安装时校验新包与已安装包的签名证书一致，通道被换掉也换不了签名。

## 为什么要经 Worker 中转

tauri-action 写进清单的制品地址是 GitHub 的 API 资产地址
（`api.github.com/repos/.../releases/assets/<id>`）。这个地址用普通 GET 取回的是资产元数据
而不是文件本身——GitHub 只在 `Accept: application/octet-stream` 时回字节，而客户端的更新器
不会带这个请求头。所以 Worker 把清单里的地址换成自己的 `/dl/<tag>/<文件名>`，再带上正确的
请求头从 GitHub 取回制品，客户端不需要任何凭据。

Worker 的每次 GitHub 调用都带 `GITHUB_TOKEN`（未配置时直接报 500）：未登录调用 GitHub API
有每小时 60 次的限制，而 Worker 的出口 IP 是共享的。

只有 GitHub 判定为「最新已发布版本」的那个 release 会被提供：草稿与预发布版本不在
其中。`release.yml` 直接发布（`releaseDraft: false`），所以 workflow 跑完就开始推给
用户。

## 域名

Worker 挂在自有域名 `mojuan.fengw.site` 下（与 `blog.fengw.site`、
`dav.fengw.site` 同一个做法）。`workers.dev` 域名在部分网络连不上——本机所在网络
实测 `*.workers.dev` 与 `1.1.1.1` 的 443 端口超时，而 `github.com`、
`cloudflare.com` 与 Cloudflare 的边缘 IP（104.16.x、162.159.x）都通，所以走
Cloudflare 边缘的子域。

## 首次配置：GITHUB_TOKEN

Worker 的 GitHub 调用需要一个只读凭据，由 GitHub 的 fine-grained PAT 提供：

1. 打开 <https://github.com/settings/personal-access-tokens/new>。
2. Resource owner 选 `fw6`，Repository access 选 `Only select repositories` →
   `fw6/mojuan`。
3. Repository permissions 里把 `Contents` 设为 `Read-only`，其余保持 `No access`。
4. 生成后写入 Worker secret（值只粘贴一次，不写进任何文件）：

   ```sh
   cd apps/updater && pnpm exec wrangler secret put GITHUB_TOKEN
   ```

写完立即可以核对：`curl -i https://mojuan.fengw.site/latest.json` 应该从
`500 Worker 未配置 GITHUB_TOKEN secret` 变成 204 或 200。

凭据出问题时通道会直接报出来，不会伪装成「没有更新」：

- `500 更新通道配置有误：GITHUB_TOKEN 看不到 fw6/mojuan…`——PAT 没选中这个仓库，
  或者 Contents 权限不是 Read-only。
- `502 更新通道故障：GitHub 401：Bad credentials`——token 值不对或已被撤销。

## Android 发布密钥

Android 只允许同签名的包覆盖安装，所以所有版本必须用同一个密钥签名；每次构建现生成
密钥会让 OTA 永远装不上（第一次装得上，之后每次都报签名不一致）。密钥只在本地生成
一次，然后以 secret 的形式给 CI 用。

生成密钥（口令与别名自定，下面用占位值；下面这条按当前目录在 `apps/updater/` 下执行，
密钥文件已在 `.gitignore` 里，放仓库外也可以）：

```sh
keytool -genkeypair -v -keystore mojuan-release.keystore \
  -alias mojuan -keyalg RSA -keysize 2048 -validity 10000
```

密钥文件与口令都要留好：丢了就再也发不出能覆盖安装的更新，只能让用户卸载重装。

写进仓库的四个 secret（Settings → Secrets and variables → Actions）：

| secret | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | `base64 -i mojuan-release.keystore \| pbcopy` 得到的单行 base64 |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 口令 |
| `ANDROID_KEY_ALIAS` | 别名（上面的例子里是 `mojuan`） |
| `ANDROID_KEY_PASSWORD` | 该别名的口令 |

**后两个口令填同一个值**：`keytool` 默认生成 PKCS12 格式的密钥库，而 PKCS12 只支持
一个口令——生成时若把 `-keypass` 设成与 `-storepass` 不同，keytool 会警告
`Different store and key passwords not supported for PKCS12 KeyStores` 并忽略它。
只有用 `-storetype JKS` 生成的密钥库才有真正分开的两个口令。

本机构建 release 包时用同一个密钥文件，本机包与 CI 包才能互相覆盖安装。

第一次切换到固定密钥时，已经装在手机上的旧包（用以前的一次性密钥或
`.scratch/mojuan-local.keystore` 签的）无法被新包覆盖，需要卸载重装一次。

## 各平台拿到哪个制品

清单里每个平台都有一条，客户端按自己当前的安装形态选，先找带安装形态后缀的键，
找不到才退回 `windows-x86_64` 这类通用键（tauri-plugin-updater 的 `get_urls`）：

| 安装形态 | 清单键 | 制品 |
| --- | --- | --- |
| Windows（NSIS 安装） | `windows-x86_64-nsis` | `mojuan_<版本>_x64-setup.exe` |
| Windows（MSI 安装） | `windows-x86_64-msi` | `mojuan_<版本>_x64_en-US.msi` |
| Linux（AppImage） | `linux-x86_64-appimage` | `mojuan_<版本>_amd64.AppImage` |
| Linux（deb / rpm 安装） | `linux-x86_64-deb` / `-rpm` | 对应的包 |
| macOS | `darwin-<arch>-app` | `.app.tar.gz`（桌面端不发 macOS 更新，这条用不到） |

Android 不走 `latest.json`：它读 `/android.json`，拿到的永远是
`mojuan_<版本>-android.apk`（通用包，四个 ABI 都在里面）。

## 日常操作

```sh
pnpm install                 # 在仓库根执行：装两个包的依赖（wrangler 的版本由 pnpm-lock.yaml 固定）
pnpm --filter @mojuan/updater test     # 单元测试，用 app-v1.4.0 的真实清单 / 签名 / 资产列表做固定装置
pnpm deploy                  # 部署（改了 src/ 或 wrangler.toml 之后）
```

本地调试：

```sh
cd apps/updater
printf 'GITHUB_TOKEN=%s\n' '<你的 token>' > .dev.vars   # 已在 .gitignore 里
pnpm exec wrangler dev
```

手工看通道状态：

```sh
curl -i https://mojuan.fengw.site/latest.json
curl -i https://mojuan.fengw.site/android.json
```

回 204 表示当前没有已发布版本可推（或该版本没有 Android 制品）；回 200 时返回的就是
客户端拿到的那份清单，里面的下载地址全部指向这个 Worker。

## 发布一个新版本

1. 打 tag 推上去（`app-v<版本>`），`release.yml` 构建并发布 release：桌面三个平台由
   tauri-action 出 `latest.json`，Android 作业出签名 APK 与 `android.json`。
2. workflow 跑完即是对外状态——更新通道立刻开始推给用户，所以推 tag 之前先确认版本
   与改动；发错了按下面的「撤掉」处理。
3. 用户端设置页点「检查新版本」即可看到：桌面端走「重启并安装」，Android 走
   「下载 → 安装 → 系统确认」。

Android 的版本号必须比手机上装的那份大（`versionName` 来自 tauri.conf.json 的
`version`，`versionCode` 由 tauri 从版本号算出，1.4.0 → 1004000）。同一个版本号重复
发布不会让用户收到更新。

## 撤掉

```sh
cd apps/updater && pnpm exec wrangler delete          # 删掉 Worker
```

再在 Cloudflare 面板的 Workers 自定义域名里删掉 `mojuan.fengw.site`，
DNS 记录会一起清掉。
