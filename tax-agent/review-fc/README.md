# 网页审核 API

北京地域 FC 3.0 函数 `tax-law-review-api`，HTTP 地址由 `lib/config.js` 指定。它使用现有百炼 Key 的 SHA-256 摘要和固定管理端 Origin 校验每次请求，OSS 访问采用 FC 角色临时凭证；静态网页没有 OSS AK。函数包由 `scripts/package-tax-review-fc.ps1` 创建，不包含本地凭证、原始审核资料或明文 Key。

网页“待审核入库”通过这一函数读取私有台账、正文预览、审核卡片及附件清单；下载时获得 60 秒有效、仅对应单个对象且强制附件下载的签名 URL。`decide` 将批准或退回决定写到不可覆盖的 `decisions/` 对象。`publish` 先写不可覆盖的发布声明，再以请求中的百炼 Key 调用固定目标知识库；进度独立写到 `publications/`，防止与周采集器台账写入互相覆盖。`plan` 不写云端，附件无法完整检索或已有旧版正式索引时阻断发布。

部署时先运行 `./scripts/package-tax-review-fc.ps1`，再用 Serverless Devs 部署 `tax-agent/review-fc/s.yaml`。需配置 `TAX_REVIEW_PACKAGE_DIR`、`TAX_AGENT_ROLE_ARN`、`TAX_AGENT_BUCKET`、`TAX_UPLOAD_KEY_SHA256` 环境变量及 `tax-fc-ak` Serverless access。Key 摘要来自现有、获授权的百炼 Key；不要把明文 Key 写入项目文件。当前函数复用项目限定的 `TaxLawWeeklyCollectorRole`，只访问本项目 OSS 前缀。部署清单显式设置 512 MB 临时磁盘，FC 3.0 创建函数时要求此项。

2026-09-24 只读云端核对：`list` 返回 7 份待审核且最近采集完整；`detail` 返回官方正文，`download` 签发的私有 OSS 链接实际下载成功；未批准资料的 `plan` 显示阻断原因，错误 Key 返回 401。真实法规的批准、退回、正式发布和抽验须由审核者在页面按资料逐项执行，部署验证未替用户作税法效力结论。
