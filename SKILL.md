---
name: bili-timeslot
description: B站三连推广「投放时段」批量设置：1.0 版拉空（清空时段=不投放）、2.0 版拉时段（按星期整日投放，不能为空，默认周一到周五）。支持多账户批量执行，自带校验。
whenToUse: 当用户说「拉空时段 / 拉时段 / 清空投放时段 / 把账户时段拉空 / 1.0 拉空 / 2.0 拉时段 / 批量设置投放时段」时使用。
---

# B站三连推广 · 投放时段（拉空 / 拉时段）

## 一、概念先说清

| 版本 | 能做什么 | 结果 |
|---|---|---|
| **1.0** | **可以拉空**：把单元的星期标签全部删掉后保存 | 投放时段为空 = **不投放时段**，广告无法展示 |
| **2.0** | **不能拉空**：必须至少选一天，否则不允许保存 | 按需求设置时段；**无需求默认周一至周五** |

> 判断账户是 1.0 还是 2.0：进 `ad.bilibili.com` 后看页面右上角有没有「切换新版」。
> 有 = 当前是 1.0；2.0 的路由是 `#/promote/promotion`，1.0 是 `#/promote/campaign/unit`。

### 默认行为（重要）：没说版本就 1.0 + 2.0 都处理

用户的口头指令往往不精确。执行时按这个规则判定：

| 用户说法 | 处理范围 |
|---|---|
| 「把某账户时段调整一下」「拉个时段」等**没有明确版本** | **1.0 和 2.0 都检查、都处理** |
| 明确说「2.0 拉时段」「新版」 | 只做 2.0 |
| 明确说「1.0 拉空」「老版清空」 | 只做 1.0 |
| 「拉空」 | 只有 1.0 能做；2.0 不允许为空，自动跳过并说明 |

实现：统一入口 `apply-timeslot.mjs`（默认 `--version=both`），按版本分别调用
`set-timeslot-1.0-fast.mjs` / `set-timeslot-2.0-fast.mjs`；某个版本不存在（该账户没有单元/项目）时报告 `absent` 跳过，不算失败。

```powershell
# 默认：两个版本都处理
node apply-timeslot.mjs --accounts=4620390 --days=1,2,3,4,5 --hours=6-18
# 只做 2.0
node apply-timeslot.mjs --accounts=4620390 --days=1,2,3,4,5 --hours=6-18 --version=2.0
# 拉空（仅 1.0）
node apply-timeslot.mjs --accounts=4620390 --clear
```
---

## 二、前置条件

1. **Chrome 已用调试端口启动**（9333），且已登录 B站广告后台。
   启动命令（在 DSH 工作区）：
   ```powershell
   node bili-cdp.mjs launch "https://cm.bilibili.com/agent/#/customer.account/account"
   ```
   首次登录需要人工过验证码（本技能不代破解验证码）。
2. 拿到两个参数：
   - `account_id`：广告主账户 ID（代理商后台账户列表里的「账户ID」）
   - `subject_id`：代理商主体 ID（进三连推广后地址栏里的 `subject_id=`，不同代理主体不同）

---

## 三、1.0 拉空（清空 = 不投放）

### 3.1 接口版（推荐，秒级）

```powershell
node clear-slot-1.0-fast.mjs --accounts=4620390 --subject=833883
node clear-slot-1.0-fast.mjs --accounts=4620390,4564097 --subject=833883 --concurrency=4
node clear-slot-1.0-fast.mjs --accounts=4620390 --subject=833883 --units=777025688
node clear-slot-1.0-fast.mjs --accounts=4620390 --subject=833883 --dry
```

原理（页面同源，直接复用登录态）：

```
GET  /platform/api/web_api/v6/sanlian/unit/get_unit?unit_id=<uid>   → result.unit_bo
POST /platform/api/web_api/v6/sanlian/unit/save_unit  {unit: {...unit_bo, launch_time: [[],[],[],[],[],[],[]]}}
```

必需请求头：`X-EffectAd-Token`，值取自 `sessionStorage['_session_<account_id>']`（进入该账户页面后自动写入）。
脚本先打开一次单元列表页（拿到 token + 单元 ID 列表），之后全部并发走接口。

**实测**：20 个单元 dry-run 8.6s；正式写约 10s 级（对比 UI 逐单元点 ≈ 15s/个）。

### 3.2 UI 版（兜底，接口变更时用）

```powershell
node set-timeslot-1.0.mjs --accounts=4620390 --subject=833883
node set-timeslot-1.0.mjs --accounts=4620390 --subject=833883 --units=777025688,777023551
```

链路：单元列表 → 逐单元打开编辑页 → 删除 7 个星期标签（svg.btn-remove）→ 保存。
每个单元约 15 秒，20 个单元约 5 分钟。

**校验（两版通用，务必做）**

- 单元列表「状态」列显示 **「不在投放时段」**
- 单元「详情」里 投放时段 = **「未选择投放时段，广告将无法展示」**
- 或直接看接口回读：`launch_time` 为 7 个空数组

---

## 四、2.0 拉时段（不能为空）

### 4.1 接口版（推荐，秒级）

```powershell
# 默认：周一至周五，整天（0-24 = 24 格）
node set-timeslot-2.0-fast.mjs --accounts=4620390 --subject=833883

# 指定星期（1=周一 … 7=周日）
node set-timeslot-2.0-fast.mjs --accounts=4620390 --subject=833883 --days=1,2,3,4,5,6

# 指定小时（左闭右开：6-18 = 06:00 投到 18:00 整，12 格）
node set-timeslot-2.0-fast.mjs --accounts=4620390 --subject=833883 --days=1,2,3,4,5 --hours=6-18

# 指定小时：列举
node set-timeslot-2.0-fast.mjs --accounts=4620390 --subject=833883 --days=1,2,3,4,5 --hours=9,10,14,15

# 只看不写
node set-timeslot-2.0-fast.mjs --accounts=4620390 --subject=833883 --dry
```

**`--hours` 语义（左闭右开，重要）**

- 区间按「投到几点整」理解：`--hours=6-18` = 06:00 投到 **18:00 整** → 勾 6..17 共 **12 格**
- 全天用 `--hours=0-24`（勾 0..23，24 格），也是默认值
- 也支持列举：`--hours=9,10,14,15`（直接指定小时格）
- 平台的小时格是整点起算：勾 `17` = 17:00–17:59

原理（同源 + `sessionStorage['_session_<account_id>']` 的 `X-EffectAd-Token`）：

```
GET  /athena/api/v1/promotions/<pid>   → data（含 promotion_time.launch_time，7 天 × 小时数组）
POST /athena/api/v1/promotions         body = data 的 12 个字段（promotion_time 换成目标时段后回写）
```

`launch_time` 形如 `[[6..17],[6..17],[],[],…]`，数组顺序 = 周一…周日，空数组 = 该天不投。
返回 `code:"0"` 即成功；脚本会同时回读改前每天的时长数（`before`）。

**已验证**：
- `--days=1,2,3,4,5,6` → 回读 `[24,24,24,24,24,24,0]`；改回 5 天 → `[24,24,24,24,24,0,0]`
- `--hours=6-18` → 回读每天 **12 格**，周一 = `[6,7,…,17]`；改回默认 → 恢复 24 格

### 4.2 UI 版（兜底，接口变更时用）

```powershell
node set-timeslot-2.0.mjs --accounts=4620390 --subject=833883
node set-timeslot-2.0.mjs --accounts=4620390 --subject=833883 --days=1,2,3,4,5 --dry
```

链路：项目列表 → 逐项目打开编辑页 → 「编辑投放时段」抽屉 → 全部清除 → 勾选星期 → 确定 → 保存。

> UI 版目前只支持「整日」。要投部分小时（如 6-18 点）请用上面的**接口版 `--hours`**。

**校验**：`GET /athena/api/v1/promotions/<pid>` 看 `data.promotion_time.launch_time` 的每天长度。

---

## 五、多条命令组合：一次拉一批账户

```powershell
# 1.0 账户批量拉空
node set-timeslot-1.0.mjs --accounts=4620390,4564097,4562687 --subject=833883

# 2.0 账户批量拉时段
node set-timeslot-2.0.mjs --accounts=4620392,4620393 --subject=833883
```

---

## 六、已知坑（踩过）

1. **1.0「批量修改 → 投放时段」把时段置空不生效**：批量弹窗里选「特定时间段投放」再留空，确定后单元时段仍是原值。
   → 拉空必须走**逐单元编辑**。
2. **1.0 空时段能保存**：删光标签后直接点保存即可，不会报「请选择时段」。
3. **2.0 空时段保存不了**：必须至少一天；脚本已内置拦截（选不到会取消并报错）。
4. **渠道慢**：这些账户接口响应慢，改完列表可能延迟。脚本每次操作后等待并在最后回读；
   手工核对时请先刷新页面再等几秒。
5. **hash 路由切换不会重载 SPA**：换账户/换项目必须 `about:blank` → 目标 URL，脚本 `navTo` 已处理。
6. **subject_id 不对会跳到「选择账户」页**：说明该账户不属于当前代理主体，需要换对 subject_id 或从对应代理商后台进入。

---

7. **列表每页最多 100 条**：单元/项目超过 100 的账户，只看当前页会漏数据（实测 128 个单元漏 28 个）。
   → v2 脚本自动翻页取全量，并在报告里给出「页面共 N 条 / 实际取到 M 个 / 翻了几页」，两者不等要警惕。
8. **连续写入会触发限流**：大量写入时接口返回非 JSON 或静默失败（1.0 `status` 不是 success、2.0 `code` 不是 `"0"`）。
   → v2 默认**串行**（`--concurrency=1`）、每笔间隔 `--interval=400ms`、失败最多重试 `--retries=3`（指数退避），
   并在结束前**逐个回读校验**，未生效的会列在 `verify.bad` 里。
## 七、文件说明

| 文件 | 作用 |
|---|---|
| `scripts/bili-cdp.mjs` | 浏览器驱动（零依赖 CDP 客户端，launch/status/nav/shot/eval/click 等） |
| `scripts/lib-cdp.mjs` | 脚本共用的 CDP 连接与工具函数 |
| `scripts/clear-slot-1.0-fast.mjs` | **1.0 拉空 · 接口版（快，首选）** |
| `scripts/set-timeslot-2.0-fast.mjs` | **2.0 拉时段 · 接口版（快，首选）** |
| `scripts/set-timeslot-1.0.mjs` | 1.0 拉空 · UI 版（兜底） |
| `scripts/set-timeslot-2.0.mjs` | 2.0 拉时段 · UI 版（兜底） |

## 八、速度对比（实测）

| 方式 | 规模 | 耗时 | 相对 |
|---|---|---|---|
| UI 逐单元 / 逐项目点击 | 20 个 | ≈ 5 分钟 | 1× |
| 接口版（并发 4） | 20 个 | ≈ 10 秒 | **~30×** |

每个账户只多一次页面加载（约 6s，为了拿 `sessionStorage` 里的 token 和对象清单），
对象本身走接口几乎不耗时。账户越多越划算。

## 九、接口版风险与兜底

1. 两套接口家族不同，都可能随版本升级变化：
   - 1.0：`/platform/api/web_api/v6/sanlian/unit/{get_unit,save_unit}`
   - 2.0：`/athena/api/v1/promotions`（GET 详情 / POST 保存）
   字段结构变了就退回 UI 版脚本。
2. `X-EffectAd-Token` 是 JWT（存在 `sessionStorage['_session_<account_id>']`），脚本每次现取；页面是登录态就没问题。
3. 并发别开太大（建议 2~4），避免触发风控；脚本默认 4，可 `--concurrency=` 调。
4. 写失败时**不要盲目重试**，先看返回：1.0 看 `status`，2.0 看 `code`（`"0"` 才是成功）；风控页会返回 403 + HTML。
5. 2.0 的 POST 是把详情整包回写，**只改 `promotion_time`**；脚本按字段白名单组装，不会覆盖其它字段。改动前建议先 `--dry` 看一眼 `before`。

6. **限流识别**：写入返回 HTTP 200 但内容不是 JSON，或 `code` 非 `"0"` / `status` 非 `success`，基本都是被限流。
   处理：不要加大并发，把 `--interval` 调大（600~1200ms）、`--retries` 保持 3，跑完看 `verify.bad` 补跑。
---

## 十、SKU → 账户 → 客户

推广负责人确认的映射（2026-11-02，权威）：

| SKU | 账户名称关键词 | 客户 |
|---|---|---|
| 建模 | 建模 | 中教 |
| 原画 | 原画 | 中教 |
| AI绘画 | AI绘画 | 启职 |
| AI视频 | AI视频 / AI漫剧 | 海豚 |
| AI写作 | AI写作 | 喜马拉雅 |

映射维护在 `sku-accounts.json`（`keywords` / `client` / 默认 `days` / `hours`）。

### 账户来源优先级（重要）

1. **用户当次明确给出的账户 ID** —— 最高优先，直接用
2. **按关键词在账户列表里查** —— 用 `node find-accounts.mjs --sku=AI绘画`（会翻完所有页）
3. **查不到就问用户** —— 不要猜、不要用别的 SKU 的账户顶替

> ⚠️ 不要假设「不同 SKU 一定属于不同投放后台账号」。这条不成立，具体看当次登录主体和用户给的账户。
> 本技能学习期用的账户（4620390 / 4564097 等）是**测试账户**，不要当成正式映射硬编码。

### 用法

```powershell
# 先查这个 SKU 在当前登录主体下有哪些账户（只读）
node find-accounts.mjs --sku=AI绘画

# 直接按 SKU 执行（未给账户时脚本会按关键词自动解析；解析不到会报错并停下）
node set-timeslot-2.0-fast.mjs --sku=AI绘画 --dry
node set-timeslot-2.0-fast.mjs --sku=AI绘画

# 用户直接报账户时，用 --accounts 覆盖
node set-timeslot-2.0-fast.mjs --accounts=4620390,4620391 --days=1,2,3,4,5 --hours=6-18
```

命令行参数优先级高于 `sku-accounts.json` 里的默认值（`--days` / `--hours` / `--accounts` / `--subject`）。

