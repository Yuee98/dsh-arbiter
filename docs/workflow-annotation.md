# 工作流独立标注与参考选择

本流程对应 #127，只读取明确选择的 grouped-v1 工作流组，不调用模型。Codex 准备独立题本，用户逐题转交其他模型，Codex 收回原文、校验并汇总。用户转交模型回答不构成人工确认；用户独立标注、复核和裁决的网页由 #128 提供，参考正式用途和人工复核范围由 #137 确定。

## 导出并登记

```sh
pnpm evals workflow-export <数据集目录> --split dev --group f01-build-cleanup --models <模型登记.json> --out <新题本目录>
```

默认只选 dev，必须指定一个组；calibration/holdout 显式选择。模型登记文件是数组，每个条目如下；对其他参与模型追加条目，不能把同一模型的代理、版本或重复采样当成不同参与者：

```json
[
  {
    "modelKey": "model-a",
    "aliases": [],
    "model": {
      "provider": "user-stated-provider",
      "id": "user-stated-model",
      "version": null,
      "versionSource": "unknown"
    },
    "parameters": {}
  }
]
```

`modelKey` 跨批次、版本与代理端点保持稳定；已知别名写进 `aliases`，避免增加 N。未知版本保持 null/unknown；provider/id 不清楚时可明确填写 `unknown`，不猜测。工具只能合并声明过的身份关系，不能证明提供者或模型在统计上独立。参数只记录实际可知值，不放 API key 等凭据。

已知的相同 provider/model ID 在同批重复登记会被拒绝；跨批即使误用了不同 modelKey，也会合并为一个参与者，版本、协议或参数不同不增加独立票。不同 provider 的潜在同模型服务以及未知身份仍依赖显式别名声明，原始身份和所有尝试照常保留。

导出成功会在 `opinions.json` 为每个准备成功的点登记全部参与模型，包括未返回者。新登记立即进入当前参考的分母，可能撤销此前的模型共识；不必等第一份回答到达。标签缓存不决定当前参考，当前状态须经 `workflow-reference` 重新计算。导出不会更改人工标签。

每个随机题号 JSON 是独立题本。**一次只转交一个题号，并为每题创建全新上下文**，同根不同点也不串聊。题本含生产共用构建器实际生成的请求、来源、裁剪和完整性说明，以及唯一有效的标注答案格式。原生产请求被明确引述，其中生产接口的“两字段”“不声明 verdict”或原生概率输出要求不作为本次标注指令；R/A 的量表语义和实际事实保持原样。不会提供组名、作者目标、后续事件、既有标签、其他意见或被测回答。

准备失败的点保留在本地批次与参考查询的 unresolved 记录中，不导出原始 workflow 作为替代题本。CLI 打印失败点及原因，不能把少了这些点的题本称为全部可评。

本地基线位于命令打印的 `.local/evals/workflow-annotation/<batchId>.json`，保存源提交/dirty、配置、实际请求、题号映射和相关记录基准；不要转交这份基线。原始模型回答随后保存在组内 `opinions.json`，不依赖 `.local` 长期保留。若基线丢失，应重新导出并核对既有意见或人工决定；不伪造基准绕过冲突。

可用 `--context <JSON>` 明确选择如下上下文，默认 6000/10000、chat、无额外规则；不读取日常宿主配置或日志。传入规则必须已完成适用脱敏，含可识别凭据的配置描述会被拒绝。

```json
{
  "protocol": "chat",
  "targetInputTokens": 6000,
  "maxInputTokens": 10000,
  "customRules": "",
  "projectRules": null
}
```

## 收回模型原文

模型只填写每题的 `answerFormat`：完整 `pairs`、独立 `behaviourReference`、理由、实际请求的逐字证据引用和已识别关键冲突。无法判断的字段保持 null；合理多配对全部保留，不压成单对。期望行为独立判断，不查被评矩阵。

Codex 将模型原文放进回传文件，不改写成模型没有说过的答案。纯 JSON 或单独 JSON fence 都可解析；其他可见文本、坏 JSON、部分答案和失败也保留。例如下面是空回传结构说明，填入真实题号和登记模型；`responseId` 为这次可见回复生成一次后保持不变，重试沿用，新的 repeat/repair 使用新 ID：

```json
{
  "batchId": "导出批次ID",
  "responses": [
    {
      "responseId": "本次回复的稳定ID",
      "questionId": "随机题号",
      "modelKey": "model-a",
      "rawResponse": null,
      "error": null,
      "metadata": {}
    }
  ]
}
```

实际 ID 使用小写字母、数字、点、下划线或连字符且不超过 64 字符。`rawResponse` 是实际可见原文字符串，未取得时为 null；实际失败原因放 `error`，未知返回元数据放 `metadata`。原文经共用凭据脱敏后保存，已导出的凭据占位符可以作为证据原样引用。结构化解析、未知 JSON 字段、理由、证据和错误随意见保留。`responseRef` 使用 `opinion:<reviewId>#annotation/rawResponse`，按当前集合中的稳定 ID 定位原文，不依赖数组位置或本地临时附件。

```sh
pnpm evals workflow-import <数据集目录> --batch <本地基线.json> --answers <回传.json>
pnpm evals workflow-import <数据集目录> --batch <本地基线.json> --answers <回传.json> --write
```

默认预览，`--write` 才写入。每个模型按持久接收顺序选第一份结构、证据完整的独立回答；失败或格式不完整可补齐，所有尝试仍保留。完整但多配对或有关键冲突的意见不会被后来的重复单值答案替换。排序不依赖 JSON 数组的位置。重复导入相同 responseId 幂等；同 ID 换内容拒绝。

共识按同一实际视图的全部批次登记模型计算 N，完整 `(R,A)` 精确同票 K 必须满足 `K >= 3 && (100*K >= 80*N || K >= N-1)`。剩余每份意见的两维偏差各不超过一档，独立行为全体一致。缺答/失败/弃权/部分答案、跨 A1、合理多配对、不可达证据或已识别关键证据冲突均不能自动采用。结果只取多数配对，不扩展为容差邻域。模型参考为 `model-consensus`、非人工确认、pending；其初版计分只表示与固定模型参考的一致程度。

每组写入使用独占 claim、相关记录基准比较及临时文件 rename。先保存意见再保存模型标签；后一步失败时明确报告意见已保留，重试相同回复可以完成写入而不重复计票。导出若登记失败，也会报告保留的基线；用同批次的空 `responses: []` 回传可以恢复登记和重算。相关人工或意见记录被外部修改时拒绝覆盖；其他点的修改与普通 JSON 格式化可保留。

多个已导出批次可以按实际回传顺序导入。模型缓存的刷新不阻止其他批次的原文追加，也不阻止同视图下的独立人工填写；新模型回复保留当前人工记录并维持人工优先。人工写入仅对相应人工决定或对应草稿做基准比较；真正的人工作答冲突仍需复核。每个角色文件发布前再核对当前内容，在意见写入阶段发生的外部人工修改不会被后续标签发布覆盖。

## 人工状态与固定参考

`workflow-adjudicate <数据集> --batch <基线> --fill <人工填写.json> [--write]` 是 #128 可复用的共享文件导入服务；不会把模型回传自动转换成人工填写。填写格式为 `{batchId, decisions:[{questionId, state, target}]}`，target 沿用现有 LabelTarget。state 为 draft、confirmed、disputed、undecidable 或 needs-review。confirmed 必须有 approved target、明确裁决人和日期；独立行为即使与当前矩阵不符也可保存，评分 null 不用模型拼补。真实人工复核仍按已确认的网页流程进行；测试里的人工填写全部是 synthetic 工程样例。

草稿与确认分开，保存草稿不覆盖已有确认。无行为结论的明确待判使用合法 pending target 加 `annotation.humanState`，重载后仍阻止机器 fallback；普通未填 pending 不等于人工争议。适用的直接人工参考优先于明确继承参考，后者须有可追溯来源；本工具不自动推断语义等价继承。

```sh
pnpm evals workflow-reference <数据集目录> --split dev --group f01-build-cleanup
pnpm evals workflow-reference <数据集目录> --split dev --group f01-build-cleanup --out <新的固定参考.json>
```

查询按当前实际视图重新选择人工、模型或 unresolved，并给出 N/K、返回/有效/缺答/失败数、支撑意见、身份、采用分支、偏差和原因。输入、预算选取或契约变化会触发复核；未展示的普通工具正文变化、作者注释和源文件格式化不会仅因源提交/前置 hash 不同而失效。含凭据占位符的视图会额外保守核对源输入，跨进程只忽略占位符随机签名，保留同值/异值关系。

`--out` 只创建新快照，不覆盖已有文件。所有候选共用同一份已固定参考；新增意见或人工修订只改变当前参考，旧快照和运行不会被改写。此服务为后续 grouped runner/report 提供可序列化接口，本 PR 不重写历史 case runner。快照和模型原文是否归档、何种参考有正式资格，仍须由具体运行/复核计划声明；生成快照不等于质量通过。
