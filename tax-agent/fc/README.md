# 云端周采集器

独立 FC 3.0 定时函数，每周只采集国家税务总局政策法规库四个栏目；证据与台账写入北京地域私有 OSS。函数不接收百炼 Key，不调用百炼发布接口。默认每栏目回看 2 页，单次最多核对 20 份正文，超额和来源失败会写入运行报告，不会标成“无变化”。

运行时通过 FC 角色获取临时凭证，RAM 角色只允许访问本项目私有 bucket。OSS SDK 使用北京地域内网 Endpoint，已于 2026-09-24 更新函数并完成云端试跑，避免定时采集读取档案产生 OSS 公网流出流量。代码包由 `scripts/package-tax-agent-fc.ps1` 从明确的文件清单生成，避免把本地凭证、旧样本或前端文件带进函数。

当前资源：

- 函数：`tax-law-weekly-collector`（北京地域，Node.js 20，256 MB／0.25 vCPU，300 秒超时），无公开 HTTP 触发器。
- 私有 bucket：`tax-law-agent-1555315958533569-cn-beijing`；仅使用 `tax-agent/v1/` 前缀。
- 执行角色：`acs:ram::1555315958533569:role/taxlawweeklycollectorrole`。
- 定时器：`weekly-official-tax-collect`，`CRON_TZ=Asia/Shanghai 0 0 9 * * MON`。

RAM 自定义策略 `TaxLawWeeklyCollectorOSSAccess` 已按本目录的 `oss-policy.json` 创建，并附加到 **角色** `TaxLawWeeklyCollectorRole`；没有使用 `AliyunOSSFullAccess`。子账号 `ruantong` 的单角色 `ram:PassRole` 已获授权。

2026-09-24 最新代码云端连续同步试跑两次，均返回 `status=complete`、`errors=0`、`candidates=7`、`pending=7`、`newVersions=0`。私有 OSS 的 `tax-agent/v1/reports/latest.json` 显示四个栏目各检查 20 条、7 份待审核材料均未变化。定时器配置为已启用。百炼正式知识库经只读核对仍有原来的 1 份文件；此函数不执行正式发布。连续四周的定时运行稳定性仍待观察。

后续同页出现新版本时，审核卡片会保留官方列表元数据、正文首处差异及附件变化的自动对照；2026-09-24 已部署并试跑该代码。当前 7 份材料没有发生新变化，所以其不可变历史审核卡片不会被改写。

云端审核决定保存在 `tax-agent/v1/decisions/<资料ID>/<SHA-256>.json`，作为不可覆盖的审核留痕。函数读取台账时会叠加决定，因此下次周报不会将已批准或退回版本继续列为待审核。人工发布前会在 `tax-agent/v1/publications/<资料ID>/<SHA-256>/claim.json` 写入不可覆盖的发布声明；发布与索引状态随后写入资料台账。审核与发布暂由本机 `cloud-admin.mjs` 受控执行，尚未提供网页管理页。
