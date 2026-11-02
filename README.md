# dsh-plugin-bili-timeslot

B站三连推广「投放时段」批量设置插件。装到 DSH 里即得命令：

| 命令 | 作用 |
|---|---|
| `/timeslot`（`/拉时段`） | 2.0 批量设置投放时段（按星期 / 小时） |
| `/clearslot`（`/拉空`） | 1.0 批量拉空（清空时段 = 不投放） |
| `/timeslot fp` | 查本机指纹（申请授权用） |
| `/timeslot activate=<许可证>` | 激活本机 |

**授权模型：按机器绑定、管理员签发、一次激活长期可用。**
插件内只有公钥，没有私钥 —— 别人拿到整个插件包也伪造不出许可证；
把许可证文件拷到别的机器会因机器指纹不符而失效。

---

## 一、安装

DSH → 插件 → 「添加插件」→ 输入本地目录路径（本包目录）→ 安装并启用。
插件是启动时加载的，装完/换版本后重启一次 DSH。

## 二、前置：浏览器 + 登录

```powershell
node scripts\bili-cdp.mjs launch "https://cm.bilibili.com/agent/#/customer.account/account"
```

需要有开着 9333 调试端口、且已登录 B站广告后台的 Chrome。首次登录的验证码需人工完成（插件不代破解）。

---

## 三、授权（管理员 = 老板本人，只需签一次）

### 1. 初始化密钥（管理员机器，只做一次）

```powershell
node scripts\authorize.mjs --init
```

- 私钥：`~/.dsh/bili-timeslot/owner-private.pem` —— **只在你机器，绝不外发**
- 公钥：写进插件 `lib/auth-public.pem`，随包分发

> `--force` 换密钥会让所有已发许可证立即失效。

### 2. 给某台机器签发许可证

对方先在自己机器上执行：

```
/timeslot fp
```

把得到的指纹（如 `8C5C-A70B-7C59-EBFC`）发给你。你签发：

```powershell
node scripts\authorize.mjs --issue --fp=8C5C-A70B-7C59-EBFC --name="启职-小王" ^
  --skus=AI绘画 --days=1-5 --hours=6-18 --expires=2026-12-31
```

把输出的许可证串发给对方，对方执行：

```
/timeslot activate=<许可证>
```

看到「✅ 激活成功」即可长期使用，**不需要每次找你要码**。

### 3. 本机自用

```powershell
node scripts\authorize.mjs --self --name="我的机器" --skus=AI绘画,原画,建模 --expires=2026-12-31
```

会自动安装并校验。

### 4. 临时一次性码（可选）

```powershell
node scripts\authorize.mjs --code --name="临时" --hours=6-18 --ttl-hours=2
```

对方在命令后加 `auth=<码>`，用一次即失效。

---

## 四、为什么没法「随处分享」

| 机制 | 效果 |
|---|---|
| Ed25519 签名 | 只有管理员私钥能签发；插件里只有公钥 |
| **机器指纹绑定** | 许可证写死指纹，拷到别的电脑直接失效 |
| 一次性 nonce（临时码） | 临时码用过即废，不能反复转手 |
| 范围限制 | 可限定 SKU / 账户 / 星期 / 小时，越界拒绝 |
| 未激活即拒绝 | 没有许可证时命令只返回指纹和申请提示 |

---

## 五、命令参数

```
/timeslot <SKU 或 账户ID列表> [days=1-5] [hours=6-18] [subject=833883] [--dry]
/clearslot <账户ID列表> [subject=833883] [--dry]
```

- `days`：1=周一 … 7=周日，可写 `1-5` 或 `1,2,3`
- `hours`：左闭右开，`6-18` = 6:00 到 18:00 整（12 格）；`0-24` = 全天
- `--dry`：只读预演，不写入
- SKU：建模 / 原画 / AI绘画 / AI视频 / AI写作（见 `sku-accounts.json`）

## 六、注意

- 1.0 拉空后广告**不再展示**，属于停投操作
- 接口失败不要盲目重试：1.0 看 `status`，2.0 看 `code` 是否为 `"0"`
- 本插件执行本地脚本，来源不明不要安装
