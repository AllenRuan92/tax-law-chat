# 百炼上传代理

此目录是 FC 3.0 的最小上传代理，不代理聊天、检索、删除，也不接收文档二进制内容。

浏览器 → FC 申请上传凭证 → 浏览器直接 PUT 至百炼 OSS → FC 登记文件 → 浏览器直接调用百炼入库 API。

## 部署状态

2026-09-22 已部署到北京地域，函数名 `tax-law-upload-proxy`，HTTP 触发器 `web-upload`。

公开地址：<https://tax-lawad-proxy-mosqgiygtw.cn-beijing.fcapp.run/>。此地址不是聊天页面；只接受已授权的上传元数据请求。

部署使用本机 `tax-fc-ak` 配置（ruantong 子账号）；AccessKey 不进入函数环境变量、前端或仓库。原 OAuth 配置保留。已通过 21 项单元测试，以及真实浏览器的列表、上传、解析入库、问答检索、移除确认和手机布局检查。

部署需要阿里云账号的 FC 管理权限。百炼 API Key 不能创建 FC。不要把 AccessKey Secret 写入仓库或聊天。

## 建议配置

- 地域：北京，与现有百炼工作空间一致。
- 函数：`tax-law-upload-proxy`，Node.js 20，处理程序 `index.handler`。
- 128 MB、0.05 vCPU、超时 60 秒、单实例并发 1、函数预留并发上限 2；无常驻/预置实例、无 VPC/NAS、无自定义域名。
- 开启公网出站。HTTP 触发器只允许 POST 与 OPTIONS，使用 HTTPS 触发器 URL。
- HTTP 触发器使用平台层匿名鉴权，但**函数代码会校验现有百炼 Key 的 SHA-256 摘要**，不是开放上传接口。未授权请求在联系百炼之前被拒绝。设置此触发器时须确认代码和鉴权环境变量均已就绪。
- 环境变量 `ALLOWED_ORIGINS=https://allenruan92.github.io`。
- 环境变量 `API_KEY_SHA256`：现有百炼 API Key 的 SHA-256 十六进制摘要，不是明文 Key。

`s.yaml` 记录本次使用的资源规格。无预置实例、无运行角色、无新增日志库；函数禁用临时凭证注入。并发限制并非费用硬上限；公网调用即使被代码拒绝，也可能产生函数调用费用。

`fcapp.run` 网关默认注入跨域响应头，因此部署入口会移除函数重复输出的 `Access-Control-*` 头，避免浏览器因多个 `Allow-Origin` 值拒绝请求。来源、方法、请求头和 Key 仍由函数代码校验，不能把 CORS 当作鉴权。当前账号的自定义 `corsConfig` API 返回内测限制，因此没有启用该功能。

## 控制台上传代码

在项目目录运行 `./scripts/package-fc.ps1`，将生成 `output/tax-law-upload-proxy-时间.zip`。上传此 ZIP，根目录只有 `index.js` 和 `package.json`，无外部依赖、无密钥。

若已经配置 Serverless Devs 的阿里云部署身份，可使用 `s.yaml`；部署前检查同名函数，避免覆盖其他资源。用环境变量 `TAX_FC_ACCESS` 选择身份，`TAX_UPLOAD_KEY_SHA256` 提供摘要。

摘要可从本机已有 `DASHSCOPE_API_KEY` 计算到当前进程的部署环境变量，不需输出明文：

```powershell
if (!$env:DASHSCOPE_API_KEY) { throw '请先在本机设置百炼 API Key' }
$taxHash = [Security.Cryptography.SHA256]::Create()
try {
  $taxDigest = $taxHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($env:DASHSCOPE_API_KEY))
  $env:TAX_UPLOAD_KEY_SHA256 = [Convert]::ToHexString($taxDigest).ToLowerInvariant()
} finally { $taxHash.Dispose() }
```

更换百炼 Key 后，须同步更新函数中的摘要。前端继续采用现有 Key/体验链接方式，不新增同事登录系统。

## 上线验收（已完成）

1. 创建函数后核对 HTTPS 触发器 URL，填入 `lib/config.js`，并只将这个确切来源加入 `index.html` 的 CSP `connect-src`。
2. 验证实际 GitHub Pages 来源的 OPTIONS 请求、错误 Key 的 401 响应；拒绝不受信任的 Origin。
3. 上传 `tests/fixtures/网页上传联调测试_2026-09-21.txt`，确认传输、登记、索引完成，原税法资料仍在。
4. 根据用户已给出的授权，只移除这份测试文档的知识库索引和切片，保留数据中心源文件。
5. 核对手机端与原聊天功能，再部署前端到现有 GitHub Pages。

联调只移除了 `网页上传联调测试_2026-09-21.txt` 的知识库索引与切片；数据中心源文件保留。问答曾成功检索该测试文档的唯一校验口令，清理后知识库恢复为原来的 1 份税法资料。

函数不会记录请求体、Authorization 或签名上传地址。后续如启用网关、审计、调试日志，也须避免记录这些字段。

参考：Serverless Devs 官方 FC3 仓库的 [HTTP 触发器示例](https://github.com/devsapp/fc3/tree/master/__tests__/e2e/trigger/http)、[函数配置示例](https://github.com/devsapp/fc3/blob/master/__tests__/e2e/nodejs/s.yaml)。
