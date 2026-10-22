# test-data：课程测验题目与答案库

本目录由 `cargo run -- --cookies D:/cookies.txt --no-video-info dump` 抓取，
并在测验全部提交、平台完成批改后重新抓取修正。目录里**不包含** cookies、token
或任何登录凭据。

## 文件

| 文件 | 内容 |
| --- | --- |
| `courses.json` | 清洗后的抓取结果：7 门课程、章节目录、任务点、测验题目、平台答案、提交得分 |
| `answer-bank.json` | 结构化答案库：课程树 + 117 份测验作业 + 541 道题 + 题号索引 + 题干索引 |
| `README.md` | 本说明 |

## 总量（2026-10-22 提交后重新抓取）

- 课程 7 门；其中 3 门有测验题（大学英语词汇解析(一)、学术英语读写(一)、国家安全教育）。
- 测验作业 117 份，题目 541 道：
  - 单选题 298
  - 多选题 53
  - 填空题 92
  - 判断题 96
  - 简答题 2
- 答案来源：
  - **386 道**平台页面直接给出正确答案（`page_correct_answer`）；
  - **139 道**平台批改满分，提交答案被确认正确（`full_score_confirmed`）；
  - **16 道**平台批改为 0 分后修正（`score_corrected_judgment` 8 道、`score_corrected_inference` 8 道）；
  - 仍有 0 道只靠模型猜测。
- 置信度：high 536、medium 3、low 2。

按课程：

| 课程 | 题目 | 平台直接答案 | 满分确认 | 0 分修正 |
| --- | --- | --- | --- | --- |
| 大学英语词汇解析(一) | 230 | 230 | 0 | 0 |
| 学术英语读写(一) | 149 | 0 | 133 | 16 |
| 国家安全教育 | 162 | 156 | 6 | 0 |

军事理论、信息技术导论(IT中国)、华科大校史与大学精神（思政）这三门课的平台目录为空，
没有测验题可抓；这是平台返回的数据，不是抓取失败。线性代数（A）有章节目录但没有测验任务点。

## answer-bank.json 结构

顶层字段：

- `stats`：总量统计、按课程统计、按来源统计、重复题干、空目录课程。
- `review`：低/中置信度题号、0 分修正题号、注意事项。
- `courses`：按课程结构嵌套。每个章节节点保留 `id/title/number/level/is_leaf/completed`，
  有测验的节点带 `quizzes`，每个 quiz 带 `work_id/work_name/work_status/knowledge_id/chapter_path/card_index/card_title/questions`。
- `question_index`：以 `question_id` 为键的扁平索引，应用查答案最方便。
- `stem_index`：以规范化题干为键的索引，值为 `question_id` 数组（重复题干会出现多个 id）。

### 题目记录字段

| 字段 | 说明 |
| --- | --- |
| `question_id` | 平台题目 id，541 道题全局唯一 |
| `question_type` | `单选题` / `多选题` / `填空题` / `判断题` / `简答题` |
| `stem` | 题干 |
| `options` | `[{label, text}]`；部分英语判断题页面没有选项，此时为空数组 |
| `answer` | 应用直接提交的规范答案：选择题/有选项的判断题是字母（如 `B`、`AC`）；无选项判断题是 `对`/`错`；填空/简答是文本 |
| `answer_labels` | 选择题/有选项判断题的字母数组；其他类型为空 |
| `answer_text` | 人类可读答案：选择题为选项文本，判断题为 `对`/`错`，填空为文本 |
| `answer_blanks` | 填空题按空拆分；多空题如 `["人民安全","政治安全","经济安全"]` |
| `accepted_answers` | 平台接受的答案集合；填空题可能有多个可接受写法 |
| `source` | `platform`（平台答案/满分确认）或 `model`（修正推断或旧模型答案） |
| `source_detail` | `page_correct_answer` / `full_score_confirmed` / `score_corrected_judgment` / `score_corrected_inference` |
| `confidence` | `high` / `medium` / `low` |
| `note` | 作答/修正说明 |
| `my_answer` | 平台记录的本次提交答案 |
| `score` | 平台记录的本题得分；`null` 表示平台没有给出数值（如部分简答题） |
| `answered_correctly` | `true`/`false`/`null`：平台是否判定本次提交正确 |
| `correct_answer` | 仅 `platform + page_correct_answer`：平台原始正确答案 |
| `previous_answer` | 仅 0 分修正题：被平台判错的旧答案 |

### 查答案

优先按 `question_id` 查：

```js
const bank = JSON.parse(fs.readFileSync('test-data/answer-bank.json', 'utf8'));
const item = bank.question_index['676256'];
console.log(item.answer);        // "frolicking"
```

题干兜底时，先做同样的规范化再查 `stem_index`：

```js
function normalizeStem(stem) {
  return stem
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^(判断题|单选题|多选题|填空题|简答题)\s*[:：]/, '')
    .replace(/[\s\W_]+/gu, '');
}
const ids = bank.stem_index[normalizeStem(stem)] ?? [];
```

`stem_index` 只用于兜底；同一题干可能对应多门课/多份作业（当前有 1 组重复），
拿到 id 后仍应结合 `course_id`/`work_id` 判断。

## 平台答案与修正方法

### 1. 平台直接答案（386 题）

大学英语词汇解析(一) 230 题、国家安全教育 156 题的平台页面直接给出了正确答案，
答案库采用平台答案，**不采用账号自己的错误作答**。

### 2. 满分确认（139 题）

学术英语读写(一) 133 题、国家安全教育 6 题没有显示正确答案，但平台批改满分。
这些题直接采用本次提交的答案，并标记 `source_detail: "full_score_confirmed"`。

### 3. 0 分修正（16 题，均为学术英语）

学术英语的已批改页面只显示“我的答案”和得分，不显示正确答案。16 道 0 分题这样修正：

- **8 道判断题**：二值题取反，`source_detail: "score_corrected_judgment"`。
  题号：`676444`、`676451`、`676455`、`676472`、`676477`、`676483`、`676487`、`676554`。
- **8 道单选题**：平台未展示正确选项，按语义排除后修正，`source_detail: "score_corrected_inference"`：
  - `676495` → C（verify），medium
  - `676497` → B（compromises），high
  - `676498` → A（allocate），low
  - `676499` → B（diminished），low
  - `676508` → C（put），high
  - `676512` → C（proved），medium
  - `676516` → C（assess），high
  - `676583` → D（should），medium

低置信度题号（建议人工复核）：`676498`、`676499`。
中置信度题号：`676495`、`676512`、`676583`。

### 4. 其他说明

- 部分英语判断题页面没有选项元素，答案库直接存 `对`/`错`；有选项的判断题存 `A`/`B`，
  并在 `answer_text` 中给出 `对`/`错`。
- `676579`（5.1 排序题）以提交的 `2；3；1` 获满分，答案按该写法录入，同时接受 `2、3、1`。
- 平台答案与旧题库文档不一致的题，以平台批改结果为准；例如 `681219` 平台答案为 D，
  `681388` 为“安全性主动权”，`681330` 为“枪杆子永远听党指挥”。
- 个别填空题平台答案与提交答案文字相同但得分为 0（如 `681254`），这是逐空提交格式问题；
  答案库仍采用平台给出的正确答案，并保留 `score: 0` 以便追溯。

## 复现

```powershell
cargo run -- --cookies "D:\cookies.txt" --no-video-info --concurrency 6 dump --out test-data/courses.json
```

解析器已修正以下平台页面差异（`src/parse.rs`）：

- 题目 id 优先取 `question*` id / `.singleQuesId` 祖先 / 选项 `qid`，不再把 `data="3"`（题型）当题目 id；
- 判断题选项标签支持 `.num_option`，多选题支持 `.num_option_dx`；
- 已批改填空题从 `.myAllAnswerBx` / `.correctAnswerBx` 提取 `第一空： ...` 答案，
  同时兼容半角冒号 `第一空:` 和全角冒号 `第一空：`。

抓取只读当前账号的课程数据；不要把 `cookies.txt`、课程令牌或平台抓包内容提交到仓库。
本目录里的 `courses.json` 已清除 `enc`、`otherInfo`、`attDurationEnc`、`ktoken`、`playback` 等
会话签名字段；重新抓取得到的原始文件会包含这些字段，提交前请先清洗。
