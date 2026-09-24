# 税务规则周监测（首期）

首期只采集国家税务总局政策法规库的财税文件、税务规范性文件、税务部门规章和文字政策解读。按中国大陆人民币基金募投管退、合伙企业和个人／机构投资者税务筛选；外籍个人股息红利规则依用户选择暂不纳入。政策原文和官方解读分开建档。北大法宝、威科先行不在自动抓取来源中。

## 本地试采和审核

```powershell
npm run tax:collect -- --pages 2 --max 20
npm run tax:list
npm run tax:report
```

私有本地目录 `output/tax-agent/` 被 Git 忽略；`review/latest.md` 是待审核清单，`versions/<资料ID>/<SHA-256>/` 保存网页快照、清理后的正文、附件、元数据和审核卡片。原文和附件任一内容变化，或官方列表中的标题、日期、文号、效力标注变化，都会形成新版本。提取器升级引起的差异单独标记为技术修订。
后续同页产生新版本时，审核卡片会列出来源元数据、正文首处差异和附件的增删改；该自动对照只是审核线索，不作税法效力结论，仍须阅读完整原文。

云端每周采集后，在本机运行 `./scripts/pull-tax-agent-review.ps1` 可把**当前云端待审核版本**下载到独立的 `output/tax-agent/cloud-review-<时间>/` 目录。脚本核对清单中的资料身份、版本状态、正文与附件 SHA-256，并生成 `review/latest.md`；下载包仅供查阅，不执行批准或发布，也不会覆盖本地试采台账。若下载期间云端版本发生变化，校验会失败，须重新拉取。

## 云端审核到百炼入库

管理端左侧“待审核入库”可读取云端当前清单、预览正文、下载原文及附件，人工批准或退回后另行预检和发布。审核决定绑定完整 SHA-256 并直接写回私有 OSS；发布声明和进度由独立对象记录，周采集写台账不会撤销审核或覆盖发布状态。网页审核 API 的部署与验证见 `review-fc/README.md`。以下命令保留为受控运维入口：

```powershell
node tax-agent/cloud-admin.mjs list
node tax-agent/cloud-admin.mjs show chinatax-5251155
node tax-agent/cloud-admin.mjs plan chinatax-5251155 --hash <完整SHA-256>
node tax-agent/cloud-admin.mjs approve chinatax-5251155 --hash <完整SHA-256> --reviewer <审核人> --applicable-from <YYYY-MM-DD> --note <原文、效力及适用期间核验依据> --confirmed-original
node tax-agent/cloud-admin.mjs publish chinatax-5251155 --hash <完整SHA-256>
node tax-agent/cloud-admin.mjs check chinatax-5251155 --hash <完整SHA-256>
```

若施行日期已核实，可在批准命令加 `--effective <YYYY-MM-DD>`；否则在审核依据中说明。`reject` 与 `approve` 参数类似，但只需哈希、审核人和退回原因。发布命令要求本机 `DASHSCOPE_API_KEY` 环境变量具备目标百炼知识库管理权限；OSS 身份从阿里云 CLI 的 `tax-fc-ak` 配置读取，不在项目文件中保存密钥。

`plan` 只读预检；批准不自动入库。`publish` 再次校验云端快照，附件尚未转成可检索正文时阻断，并先在 OSS 写入不可覆盖的发布声明，防止同一版本重复提交。若发布调用结果不确定，先核对百炼文件与 OSS 台账，不能直接重试。`check` 确认索引完成后标记为 `indexed_needs_qa`，仍须做网页与微信代表性问答抽验，才能视为发布验收完成。目前这 7 份材料均未获批准，正式知识库没有新增文件。

**待审核不等于可以入库。** 核验效力、适用期间、附件和关联文件后，用当前版本的完整哈希批准；带附件资料在附件尚未转成可检索正文前，发布程序会阻断。`publish` 只有审核通过后才调用百炼，并且索引完成只进入 `indexed_needs_qa`，尚须完成问答抽验。

```powershell
node tax-agent/cli.mjs show chinatax-5251155
node tax-agent/cli.mjs approve chinatax-5251155 --hash <完整SHA-256> --reviewer <审核人> --applicable-from 2026-01-01 --note <已核对的效力与时点依据> --confirmed-original
node tax-agent/cli.mjs publish chinatax-5251155
node tax-agent/cli.mjs check chinatax-5251155
```

公告的“适用起始日”与“施行日”分开记录；如官方原文未明确施行日，`--effective` 留空并在审核依据说明。当前项目没有对历史版本的自动索引替换功能，旧版本已发布时程序会阻断新版本发布，要求单独审核切换清单。

## 云端采集

独立的北京地域 FC 3.0 函数 `tax-law-weekly-collector` 使用临时角色凭证和同地域内网地址访问私有 OSS bucket `tax-law-agent-1555315958533569-cn-beijing` 的 `tax-agent/v1/` 目录。周一 09:00（北京时间）的定时器已配置。函数不持有百炼 Key，也不写正式知识库。归档目录有 `records/`、`versions/`、`runs/` 和 `reports/latest.json`。私有 OSS 是跨周台账；FC 临时磁盘不承载唯一数据。

部署代码位于 `tax-agent/fc/`，由 `scripts/package-tax-agent-fc.ps1` 明确打包。执行角色只允许访问本项目 OSS 目录；RAM 子账号 `ruantong` 只需要对该角色的 `ram:PassRole` 才能把角色配置到函数。

执行角色的项目限定 OSS 策略已附加，最新代码于 2026-09-24 云端连续试跑两次成功：四个栏目均已检查、`errors=0`、待审核 7 份、`newVersions=0`。周一定时器已启用；连续四周的定时运行稳定性仍待观察。角色策略及验收状态见 `tax-agent/fc/README.md`。

OSS 费用按实际存储、成功请求和公网流出分别计量。当前 bucket 是北京地域 Standard/LRS、私有、无跨地域复制；2026-09-24 项目目录约 28.6 MB（含部署包）。按[阿里云存储费用文档](https://help.aliyun.com/zh/oss/storage-fees)给出的标准本地冗余示例价 ¥0.12/GB/月，存满 1 GB 约 ¥0.12/月，当前容量约 ¥0.003/月。阿里云[计费案例](https://help.aliyun.com/zh/oss/billing-examples)给出的普通请求示例价为 ¥0.01/万次、公网流出示例价 ¥0.50/GB；案例注明单价取自 2024-11-20，实际以当前价格页及账单为准。函数已改用 OSS 内网地址，正常周采集不产生 OSS 公网流出费。本机下载审核包会产生少量公网流出。函数计算和百炼另行计费。

## 当前边界

这套首期代码提供官方来源采集、不可变证据、版本去重、网页审核区及受控发布接口。附件型法规的表格/PDF 条目解析、关联法条的自动效力核验、自动问答抽验、旧版索引替换以及连续四周运行验收仍需后续实施。任何栏目失败、超出单次上限或发布状态不确定都会显示在报告中，不会写成“无变化”。
