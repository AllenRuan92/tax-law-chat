# 公众号网页问答 · 公开 POC

公众号「钻木者得火」已实际验证：手动自定义菜单可通过“发送消息 → 文字”提供网页链接，无需小程序或文章中转。

当前按所有者明确要求调整为：**固定网址直接可用，不设到期时间，不要求登录、体验码、API Key 或临时令牌，不设置自定义访问次数/并发限制。** 这不是仅限公众号粉丝使用：任何知道网址的人都可以提问，费用由所有者承担。

## 固定入口

<https://allenruan92.github.io/tax-law-chat/wechat.html>

把此地址保留在“税务助手”菜单发送的文字中即可。**不需要重新启用开发者消息推送**，以免影响手动菜单管理。URL 本身没有到期时间；可用性仍依赖 GitHub Pages、FC、百炼服务、账户余额和网络。

- 问答云函数：`tax-law-wechat-bot`，北京地域。
- 问答接口：<https://tax-lawchat-bot-kycjexvvew.cn-beijing.fcapp.run/chat>
- 兼容回调：<https://tax-lawchat-bot-kycjexvvew.cn-beijing.fcapp.run/wechat/callback>
- 原上传代理和知识库管理页不变，未扩大其权限。

## 权限与数据

- 百炼 API Key 仅放在 FC 环境变量，不放入浏览器、URL、对话备份或 Git 仓库。
- 云函数只有设置 `PUBLIC_CHAT=true` 才开放匿名问答；未显式开启时仍拒绝无有效旧令牌的请求。该标志是部署选项，客户端不能覆盖。
- 公开模式不验证、不续期、不要求访客令牌。旧 `#access=...` 链接也能打开，片段会立即移除；旧令牌最多用于选择本机已有历史记录，**不是认证凭证**。
- 浏览器请求不带 Authorization，不依赖微信 OpenID、AppSecret、access_token 或 IP 白名单。
- 后端仅调用固定知识库应用，不开放上传、下载或其他管理接口。请求角色、长度和结构仍校验，模型输出采用安全文本/Markdown 渲染，不执行 HTML。
- CORS 仅允许现有 Pages origin；**CORS 不是鉴权，也不能防止他人自行编写客户端调用公开接口**。
- 多会话存在本机 IndexedDB，不建立服务器会话数据库。升级时优先沿用保存的历史分区、旧标签页分区，或唯一旧访客分区，不合并/删除多个旧访客分区，不读取原管理页记录。共享浏览器配置的人仍可能看到本机数据，这不是账号隔离系统。
- 问题与最近最多 10 轮完整问答会传给 FC 和百炼；合计最多 24,000 字符，单个问题最多 6,000 字符。失败/停止回答不进入后续上下文。
- 云函数不记录消息正文，但云厂商和百炼有各自的数据处理政策。公开知识库不应放入不适合向公众提供的资料；不要输入身份证号、未公开交易等敏感信息。

## 费用与运行限制

模型、知识库、FC 请求/运行费用仍计入当前阿里云账户。按用户要求移除了原每分钟 6 次的应用限流，以及此问答函数原来的 `reservedConcurrency=2` 自定义并发上限。没有增加访问码、登录或预算封顶。

保留 256 MB、0.1 CPU、180 秒 FC 超时、150 秒上游超时和单次输入/输出长度保护。`instanceConcurrency=1` 是每个实例的执行配置，不是整个函数的并发上限；函数可按平台规则扩容。阿里云账号级/模型服务配额及平台限流仍然适用，前端仍避免重复点击提交同一轮问答。

没有增加 OSS、Redis、日志库或预置常驻实例。停止网页等待不保证中止已发出的百炼计费请求。该配置适用于所有者接受费用和公开访问风险的 POC，正式运营应重新评估鉴权、限流和预算控制。

## 兼容旧回调

微信回调继续强制验签、AES 加解密、AppID 及时间窗口校验；公开问答不代表开放微信回调伪造。若以后启用消息推送，回调也会回复同一个固定网址，不再生成 24 小时专属链接。当前手动菜单不需要它。

私密配置保存在被 Git 忽略的 `output/wechat/公众号消息推送配置.local.txt`。无需把 Token/AESKey 放进菜单或发给访客。旧签名/加密代码和测试保留用于兼容，不代表当前公开问答仍有到期限制。

## 开发、测试、部署

```powershell
npm ci --prefix wechat
npm test
node wechat/deploy.mjs --prepare
Compress-Archive -LiteralPath output/wechat/index.js -DestinationPath output/wechat/wechat-新版本.zip
node wechat/deploy.mjs --zip '完整绝对路径/output/wechat/wechat-新版本.zip' --resume --public-chat
node wechat/smoke.mjs --chat
```

需本地阿里云 `tax-fc-ak` profile 与进程环境 `DASHSCOPE_API_KEY`；不输出凭证。首次切到公开模式必须显式传 `--public-chat`，后续更新保留已有模式。部署前校验函数身份和旧并发配置。ZIP 只含 esbuild 生成的 `index.js`，不含本地配置。

`smoke.mjs` 构造合成入站回调，不向真实微信用户发消息；`--chat` 执行一次真实匿名问答。`tests/wechat.browser.cjs` 默认 mock 问答，`--real` 追加全新浏览器无令牌问答，`--live` 从已发布的 Pages 加载网页。设置 `TAX_PLAYWRIGHT_MODULE` 可使用已有 Node Playwright。

## 官方参考

- 消息推送：<https://developers.weixin.qq.com/doc/subscription/guide/dev/push/>
- 消息加解密：<https://developers.weixin.qq.com/doc/subscription/guide/dev/push/encryption.html>
- 被动回复：<https://developers.weixin.qq.com/doc/subscription/guide/product/message/Passive_user_reply_message.html>
