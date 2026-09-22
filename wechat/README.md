# 公众号网页问答

个人主体公众号「钻木者得火」收到文字后，被动回复专属网页入口。用户打开网页后连续提问，不需要填写百炼 API Key，也没有知识库管理权限。

本方案不调用客服消息接口，不需要 AppSecret、微信 access_token 或 IP 白名单。个人主体无法使用仅对企业认证账号开放的客服消息 API，不能靠该接口异步推送 AI 答案。

## 已部署入口

- 页面：<https://allenruan92.github.io/tax-law-chat/wechat.html>
- 回调：<https://tax-lawchat-bot-kycjexvvew.cn-beijing.fcapp.run/wechat/callback>
- 云函数：`tax-law-wechat-bot`，北京地域，与原上传代理完全分开。

直接打开页面不会获得提问权限。真实用户需从公众号的被动回复取得签名入口；本地联调入口只用于测试，不能当成公众号真实接入已完成的证明。

## 公众号后台配置

部署脚本生成私密的 `output/wechat/公众号消息推送配置.local.txt`，里面有 URL、Token 和 EncodingAESKey。该目录被 Git 忽略，勿上传或转发。

1. 在该公众号的「基础信息 → 域名与消息推送配置」中配置消息推送。
2. 填入文件中的 URL、Token、EncodingAESKey，选择 **安全模式 / XML**。
3. 保存并启用。启用开发者消息接收后，微信后台原有自动回复等功能可能受影响。
4. 用微信向公众号发送任意文字，收到专属链接后打开，发送问题并追问。

仅配置后台保存成功还不算端到端验证；必须从实际微信客户端收到链接并完成问答。微信可能对外链弹出风险提示；GitHub Pages 在部分中国大陆网络或微信内置浏览器访问不稳定时，需后续换用可备案的国内域名/网页托管。

## 权限与数据

- 百炼 API Key 只存在云函数环境变量，网页和 Git 仓库不包含该 Key。
- 入口为 HMAC 签名的持有者凭证，有效期 24 小时。转发链接会转让这段时间的提问权限，所以不要转发。刷新后仍可使用当前标签页暂存的入口；关闭标签页可能需要重新从公众号进入。
- URL 片段被读取后立即移除，令牌存于 `sessionStorage`；不放在普通查询参数里，不写日志。
- 不把 OpenID 直接放在令牌里，而是使用服务端 HMAC 产生的化名标识。
- 本地 IndexedDB 保存多会话，按访客化名分区，与原管理页分开。它不是设备级登录保护：能访问同一浏览器配置的人仍可能读到本地数据。
- 请求上下文由浏览器发送到云函数和百炼。只发送最近最多 10 轮完整问答，合计不超过 24,000 字符；单个问题最多 6,000 字符。停止/失败回答不进入后续上下文。
- 云函数不建立会话数据库，不记录消息正文；云厂商和百炼仍有各自的请求处理与数据政策。避免输入个人身份、企业未公开交易等敏感资料。
- 安全模式强制验签、校验 AppID、处理微信专用 32 字节 PKCS7 填充，拒绝 DTD、重复 XML 字段及超大请求。加解密通过微信官方 Java SDK 已知向量验证。
- CORS 只允许现有 Pages origin；它不是鉴权。真正鉴权由入口签名完成。

## 费用与限制

百炼模型调用、知识库费用和 FC 请求/运行费用仍计入当前阿里云账户。此函数配置为 256 MB、0.1 CPU、180 秒超时，预留并发上限 2；**reservedConcurrency 是并发上限，不是预置常驻实例**。

没有新增 OSS/Redis/日志库，也没有预置常驻实例。本实例限流是每个暖实例每访客每分钟 6 次且同实例同时最多 1 次，仅为 POC 的尽力限制，不是持久全局预算，也不能防止访客转发入口。停止网页等待不保证中止已发出的百炼计费请求。公开推广前建议加持久限流、明确配额、监控告警、访问审核和国内网络部署验证。

## 开发、测试和更新

```powershell
npm ci --prefix wechat
npm test
node wechat/deploy.mjs --prepare
Compress-Archive -LiteralPath output/wechat/index.js -DestinationPath output/wechat/wechat-新版本.zip
node wechat/deploy.mjs --zip '完整绝对路径/output/wechat/wechat-新版本.zip' --resume
node wechat/smoke.mjs --chat
```

本地需有阿里云 `tax-fc-ak` CLI profile 与进程环境 `DASHSCOPE_API_KEY`；脚本不输出凭证。重新部署保留原微信 Token/AES/signing key，并校验既有函数身份，不能直接覆盖不匹配的资源。

`smoke.mjs` 构造合成入站回调，不向任何真实微信用户发消息。`--chat` 会执行一次真实百炼问答。浏览器测试 `tests/wechat.browser.cjs` 默认 mock 问答，`--real` 追加真实跨域问答，`--live` 从已发布的 Pages 加载网页。需本地 Playwright 或设置 `TAX_PLAYWRIGHT_MODULE`。

后端由 esbuild 打包成单个 CJS 文件，ZIP 仅包含 `index.js`，不会打包本地凭证。改动前端配置只允许填写公开的云函数 URL。

## 官方依据

- 客服消息权限：<https://developers.weixin.qq.com/doc/subscription/api/customer/message/api_sendcustommessage>
- 消息推送：<https://developers.weixin.qq.com/doc/subscription/guide/dev/push/>
- 消息加解密：<https://developers.weixin.qq.com/doc/subscription/guide/dev/push/encryption.html>
- 被动回复：<https://developers.weixin.qq.com/doc/subscription/guide/product/message/Passive_user_reply_message.html>
