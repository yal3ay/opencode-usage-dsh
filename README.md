# opencode-usage-dsh

**在 DeepSeek Harness 的「設定」對話框裡看 opencode.ai 的套餐額度。**

把你想貼的那張用量卡（5 小時滾動 / 每週 / 每月、剩餘百分比與重置倒數）搬進 DSH：
Host 半每 30 秒輪詢 opencode 官方額度介面，瀏覽器半用官方的
`settings.section` 插槽渲染成一個設定頁。API key 只在 Host 行程內使用，
不會經過任何 RPC。

## 功能

| 能力 | 說明 |
| --- | --- |
| 三檔額度 | `rolling`（5 小時）、`weekly`、`monthly`，顯示剩餘百分比、重置倒數與進度條 |
| 套餐模型數 | 同時讀 `GET <base>/v1/models`，顯示方案可用模型數量 |
| 自動更新 | 每 30 秒輪詢一次；倒數計時另外每 30 秒自行刷新 |
| 手動刷新 | 卡片右上角「刷新」，會先叫 Host 立即重讀再取快照 |
| 主題相容 | 全部用行內樣式與 `rgba(128,128,128,…)` 中性色，深/淺色主題皆可讀 |
| 憑證安全 | key 由 `ctx.credentials` 在 Host 端解析，僅百分比 / 重置時間 / 模型 id 過 Remote |

## 前置條件

- DeepSeek Harness 0.2.0-rc.2（Desktop 或 Web profile）。
- 已配置 OpenCode 憑證，二選一：
  - profile 的 `llm-pi-ai.providers` 有一個 opencode 系 provider（id 為 `opencode` / `opencode-go`，
    或 `apiKeyEnv` 以 `OPENCODE` 開頭，或 `baseURL` 含 `opencode.ai`）；或
  - 直接在 DSH 憑證裡放 `OPENCODE_GO_API_KEY`（或 `OPENCODE_API_KEY`）。
- 本機能連上 `https://opencode.ai`。

用法示例（放在 profile 的 `cordis.patch.yml`）：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      opencode-go:
        apiKeyEnv: OPENCODE_GO_API_KEY
        models:
          - id: deepseek-v4-flash-vision-exp
            name: DeepSeek V4 Flash Vision Exp
```

## 安裝

從 GitHub 直接安裝（最省事，日後 `dsh plugin update` 也能跟著更新）：

```bash
dsh plugin --profile <profile> add github:yal3ay/opencode-usage-dsh
```

也可以裝本地目錄或打包好的 tgz：

```bash
dsh plugin --profile desktop add /絕對路徑/opencode-usage-dsh-1.0.0.tgz
```

這一步會把套件裝進該 profile 的 `node_modules`，**並自動把 `opencode-usage-dsh`
加到 `dsh.profile.bundles`**；套件內附的 `cordis.patch.yml` 接著插入宿主插件行
（已實測 `dsh --profile <name> --dump-config` 會出現 `id: opencode-usage-dsh`）。

重啟該 profile（沒有開 HMR 時），重新載入頁面，打開
**設定 → OpenCode 用量**。

若不想改 bundle 清單，也可以只把下面兩行加進
`~/.dsh/profiles/desktop/cordis.patch.yml`：

```yaml
- insert:
    - id: opencode-usage-dsh
      name: 'opencode-usage-dsh'
```

> 用 GUI 的「外掛」頁安裝也可以：它會同步處理依賴與 bundle 清單。

## 驗證

```bash
node test/smoke.mjs
```

- Host 半：若環境或 `$DSH_HOME/.credentials.yaml` 有 `OPENCODE_GO_API_KEY`，
  會**直接打真實**的 `https://opencode.ai/zen/go/v1/usage` 並檢查三檔額度與重置時間；
  沒有憑證時改用樁資料，因此可離線執行。
- 瀏覽器半：在假 `window.__ModuleLoader__` 裡載入 `lib/client.js`，驗證
  `settings.section` 註冊、Remote 讀取、渲染文字與刷新流程。

### 已做過的端到端驗證

在一個獨立的 `DSH_HOME`（同樣從 web 模板建立）裡實測：

1. `dsh plugin --profile <name> add <tgz>` → 依賴安裝成功，且自動把
   `opencode-usage-dsh` 寫進 `dsh.profile.bundles`。
2. `dsh --profile <name> --dump-config` → 組裝結果出現 `id: opencode-usage-dsh`。
3. 啟動該 profile → Host 半確實被載入並輪詢，14 秒後快照即為
   `opencode-go` / key 已解析 / 36 個套餐模型 / rolling 92% 剩餘、weekly 97%、monthly 99%。
4. 同一頁面的 client module 清單包含並可下載 `opencode-usage-dsh/client.js`。

## 運作原理

```
設定頁 (browser)                        Host 行程
  │                                        │
  ├─ ctx.remote.$mount(descriptors) ───────┤  Typert Remote namespace `opencodeUsage`
  ├─ namespace.snapshot()  ───────────────▶├─ 30s 輪詢
  ├─ namespace.refresh()   ───────────────▶│   GET https://opencode.ai/zen/go/v1/usage
  │                                        │   GET https://opencode.ai/zen/go/v1/models
  ◀── { accounts:[{ usage:{rolling,weekly,monthly}, modelCount, … }] }
```

- 憑證店是非同步載入的，第一次輪詢可能跑在它前面；Host 半會在啟動後
  ~1.2s / ~5s 各補一次輪詢，所以第一畫面就能拿到額度，而不是等 30 秒。
- 額度介面回傳 `{ usage: { rolling, weekly, monthly: { status, percent, resetsAt } } }`，
  其中 `percent` 是**已使用**百分比，UI 顯示 `100 - percent`。
- 這個讀取不消耗套餐額度（純帳號狀態查詢）。
- 同一把 key 在多個 provider 下只抓一次；provider 沒有 key 時卡片會提示未配置。
- 進度條顏色：剩餘 ≥ 40% 綠、15–39% 琥珀、< 15% 紅。

## 解除安裝

```bash
dsh plugin --profile desktop remove opencode-usage-dsh
```

再從 profile 的 `dsh.profile.bundles` 或 `cordis.patch.yml` 移除對應條目（用 GUI
外掛頁安裝的，在那裡停用／移除即可）。

## 已知限制

- 官方介面只給百分比，沒有金額明細；「還差多少錢」無法從 API 得知。
- 只讀 opencode 官方 Zen / Go 端點；自架或改寫過的閘道若沒有 `/v1/usage` 會顯示錯誤。
- 此套件為社群外掛，非 DeepSeek 官方維護。

## 授權

MIT
