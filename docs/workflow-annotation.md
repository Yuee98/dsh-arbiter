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

基线还包含用于严格重试核验的批次私有随机 key，以 `0600` 创建和更新，须留在非 Git 本地文件中。公开意见只保存其 HMAC，避免无密钥原文摘要成为低熵凭据的枚举依据；同一基线支持跨进程幂等重试，并拒绝同 ID 仅秘密值变化的回复。旧批次缺少该 key 时，模型导入会明确要求重新导出；题本、意见、标签和参考不包含该 key。

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

证据必须包含非空白的实际案例材料；固定评分契约、协议问题、章节标题和材料说明不能单独充当事实证据，带标题但包含实际事实的整段引用仍可使用。导入与当前参考查询使用相同的可达性检查，已保存的 `complete` 标记不替代理由和证据复核；无效尝试的原文与解析继续保留，后续完整回答可按既有修复规则参与选票。这只验证结构和引用位置，不证明解释正确或语义相关性。

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

## 模型中性精确选集与回收任务包（#136）

本流程先离线准备模型中性题本，再由操作者明确参与模型、逐题转交并回收原文。准备不登记模型、不写意见/标签，不改变共识分母。模型名单、真实调用与费用、人类复核分别按适用授权执行；这些命令不请求 provider，也不自动发送题目。

### 固定评分内容

每题 JSON 由 `buildAnnotationView` 与共享 `independentQuestion` 生成，包含同一套 `annotationInstructions`、当时实际可见的 `productionRequest`、`answerFormat` 与字段说明。文件 agent 和网页模型使用完全相同的 JSON，渠道说明只规定输入、输出位置和交接方式。生产评分 prompt 不因此改变。

每题使用全新独立上下文；同根不同点也不能共用作答上下文。不向模型转交整个题本、`private/`、作者预期、其他模型答案或私有批次控制文件。只判断待审动作，不执行它。保留合理的多个 `[risk,authorization]` 配对；无法评分时用 `null`，不保留空白模板的 `pairs: []`。`behaviourReference` 独立判断，不从矩阵反推。理由、逐字证据及冲突按原答案契约保留。

### 精确准备首轮与后续范围

在本版本仓库根目录使用外部临时 `DSH_HOME` 执行生产材料相关命令。首轮配置只复用 `cw-134-first-four.json` 的 20 个 `workflow.points` 身份，不沿用该历史 plan 的数据路径、端点或费用说明：

```sh
export DSH_HOME="$(mktemp -d)"
pnpm evals workflow-prepare evals/datasets/reviewer-v2 \
  --selection evals/plans/cw-136-pilot-points.json \
  --context evals/plans/cw-136-annotation-context.json \
  --out .local/evals/workflow-annotation/pilot-20
```

选集严格校验 group/root/point/primary view、重复项和 split。首轮只含 001、007、013、017 四根各 5 点。当前 24 根共 117 点；后续 `cw-136-remainder-points.json` 明确其余 97 点，不含首 20 点，不假设每根都恰好 5 点。后续准备使用相同命令、更换 selection 与新的 `remainder-97` 输出目录；准备完成不表示已经标注。

输出目录必须新建；已有目录不覆盖。构建先完成全部所选材料，再通过独立暂存目录发布；失败报告保留 stage 的位置，不把少于 20 题当作首轮成功。排查失败后选择新的输出目录重试，保留旧工件，不通过清空既有答案恢复。

```text
pilot-20/
  README.txt
  questions/<group>/<questionId>/question.json
  questions/<group>/<questionId>/TASK.txt
  private/<group>.json
```

`questions/` 每个单题目录已预留一次 initial 中性任务，其指定 answer.txt 尚不存在；准备命令返回对应私有 receipt，可直接交给一个参与者一次。新的模型或尝试必须先创建新任务目录。`private/` 为本地控制基线和 receipt，权限受限。两者不能一起转交。私有基线使用既有 `workflow-annotation-v1` 的 `prepared` 状态，models/opinions/registrations 为空，不能直接导入模型或人工意见。生产来源、context 与绑定随基线保留，重新登记、创建任务及回收时均重建实际材料校验；保存的 request 和公开题目即使被一起改动，也不能借用原 binding。

### 每次转交建立独立结果位置

即使尚未决定模型名单，也可以从 prepared 基线建立单题任务。以下 `<group>`、`<questionId>` 按准备命令输出及单题目录选择；`--attempt` 是本地安全名称，不是新增投票者：

```sh
pnpm evals workflow-task evals/datasets/reviewer-v2 \
  --batch .local/evals/workflow-annotation/pilot-20/private/<group>.json \
  --question <questionId> --attempt initial \
  --channel file --out .local/annotation-tasks/<questionId>/initial
```

命令返回该次专属 `directory`、`result` 和私有 `receipt` 路径。只向文件 agent 提供这个单题目录的 `TASK.txt` 与 `question.json`，让它只新建指定 `answer.txt`。网页模型读取同一 JSON，只返回答案 JSON 原文；操作者按 `--channel web` 创建另一独立任务，并将回传原文新建保存到该任务的 `answer.txt`。不要为网页渠道修改评分指令或重写回答。

每个模型、每次尝试均先创建新的任务目录；同一题的重试也不能共写旧 `answer.txt`。结果存在时拒绝覆盖。无模型任务的 receipt 中 `modelKey` 为 null；这只代表身份尚待确认的原文，不能算作意见或增加 N。可以使用 `workflow-collect` 不带 `--write` 先保留原文，其归档仍在本地私有目录。

### 登记实际参与者

参与模型明确后，由操作者提供符合既有 `RegisteredModel[]` 的 models JSON：真实 `modelKey`、`aliases`、provider/id、已知版本及其来源、参数。版本不明确使用 `version: null`、`versionSource: "unknown"`；不填写虚构版本、dummy 模型或凭据。同模型别名/代理/版本/重复尝试不得伪装为新的独立投票者。

逐个业务组先预览，再显式登记：

```sh
pnpm evals workflow-register evals/datasets/reviewer-v2 \
  --prepared .local/evals/workflow-annotation/pilot-20/private/<group>.json \
  --models /path/to/actual-models.json \
  --out .local/evals/workflow-annotation/pilot-20/private/registered/<group>-models.json
# 核对参与者与范围后，使用同一命令加 --write。
```

登记后的普通基线保存在 prepared 的 `private/registered/` 内，使用新 batchId，保留题号和材料绑定；原中性题本不回写。只有实际 `--write` 登记才发布 missing registrations。若意见写入或 checkpoint 失败，保留返回的 ordinary baseline；按错误说明，用已有 `workflow-import` 配合该 batchId 的空 responses 恢复登记，不重新生成参与者或覆盖基线。

已登记模型的新任务使用对应 ordinary baseline，并加 `--model <实际modelKey>`。如果先前已有同题中性任务的回传，可加 `--origin <原私有receipt>`：工具核验原题一致，将原文独占复制到新的已登记任务结果位置，并在新 receipt 中固定原 responseId、attempt、渠道。保留原文件与 receipt；这次复制是身份确认后的回收接线，不是一次新的模型作答。实际身份必须由操作者确认，工具不能从匿名文本推断模型。

### 回收、预览、保存与失败

```sh
pnpm evals workflow-collect evals/datasets/reviewer-v2 \
  --batch /path/to/registered-baseline.json --receipt /path/to/private-receipt.json
# 核对预览后，同一命令加 --write。
```

工具核验批次/题号/实际参与者和生产材料，再读取该任务指定的常规 `answer.txt` 文件。符号链接、目录重定向、非预期位置或读取错误会拒绝；不会把私有文件误收为模型原文。私有 receipt 不放在模型可写目录内。

原文先作为独立私有 attempt 归档，然后封装现有 batchId/questionId/modelKey/responseId，进入既有意见解析和导入服务。坏 JSON、schema 错误和不完整答案也保留原文及失败原因，不自动修答案。预览不写 dataset，`--write` 仍先执行预览；即使正式意见保存失败，已合法回收的原文仍保留。相同 receipt 的预览、保存和重试复用完整不可变 envelope；修改原文后重用同一身份会拒绝，不能通过重生成时间或 responseId 绕过冲突。

没有文件本身是回收操作错误。仅在操作者明确记录模型报告失败或到截止仍无返回时，用互斥的 `--error "原始失败说明"` 或 `--missing`，且该任务不能已有 answer.txt。其 rawResponse 为 null；文件权限、坏路径或符号链接错误不能转换成模型判断。

同模型多次尝试仍沿原共识规则，只保留一个参与者分母和既有首个完整有效意见选择，不挑最好答案；所有原始尝试保留。模型初版最多形成 model-consensus pending，不构成人工确认。人类独立初判、复核与裁决仍使用现有本地标注页。此离线工程子阶段不完成 #136 的真实试标和报告，也不关闭该 issue。
