# MO_TA_CHI_TIET_369FUTURES.md — MÔ TẢ CHI TIẾT VÀ TOÀN DIỆN HỆ THỐNG 369FUTURES

> **Dự án**: 369futures (PP369 AutoTrade Bot)  
> **Ngôn ngữ**: Node.js (ES6+ CommonJS)  
> **Nền tảng**: Binance Futures REST & WebSocket API, Telegram Bot API  
> **Ngày cập nhật**: 30/07/2026

---

## 📋 MỤC LỤC

1. [TỔNG QUAN HỆ THỐNG](#1-tổng-quan-hệ-thống)
2. [KIẾN TRÚC THƯ MỤC VÀ TỆP CỐT LÕI](#2-kiến-trúc-thư-mục-và-tệp-cốt-lõi)
3. [PHƯƠNG PHÁP & THUẬT TOÁN 369 (PP369 CORE)](#3-phương-pháp--thuật-toán-369-pp369-core)
   * 3.1. Khái niệm Mốc Gốc (Origin Levels) & Lưới Mốc (Grid Levels)
   * 3.2. Bảng Bước Giá (Price Step Rules)
   * 3.3. Thuật toán Roundtrip & Trạng thái Lần Chạm (`lastSide`)
   * 3.4. Bộ Lọc An Toàn (Grid Width, Blacklist, Tiêu chí 2 Volatility)
   * 3.5. Quy Trình Lấy và Lọc Mã Theo Dõi (Symbol Selection Workflow)
4. [HỆ THỐNG ĐÁNH ĐIỂM HỘI TỤ (CONFLUENCE SCORER)](#4-hệ-thống-đánh-điểm-hội-tụ-confluence-scorer)
5. [LUỒNG XỬ LÝ & ĐẶT LỆNH TỰ ĐỘNG (AUTOTRADER EXECUTION)](#5-luồng-xử-lý--đặt-lệnh-tự-động-autotrader-execution)
   * 5.1. Khởi chạy & Khởi tạo Cache
   * 5.2. Tính Đòn bẩy & Ký quỹ Mục tiêu (Dynamic Margin & Leverage)
   * 5.3. Luồng Đặt lệnh & Quản lý Lệnh Treo (Pending Limits & Bounce Cancel)
   * 5.4. Luồng Quản lý Vị thế Mở (Trailing SL, Virtual TP / Virtual SL)
   * 5.5. Cơ chế Bảo vệ Metadata Vị thế (`activeTradesMetadata`)
6. [HỆ THỐNG THU THẬP DỮ LIỆU AI (DATASET COLLECTOR)](#6-hệ-thống-thu-thập-dữ-liệu-ai-dataset-collector)
7. [TÍCH HỢP TELEGRAM & CẤU HÌNH VẬN HÀNH (PM2)](#7-tích-hợp-telegram--cấu-hình-vận-hành-pm2)

---

## 1. TỔNG QUAN HỆ THỐNG

**369futures** là hệ thống giao dịch tự động (AutoTrader) và phát tín hiệu cho thị trường Crypto Futures trên sàn **Binance Futures**. Hệ thống hoạt động dựa trên phương pháp toán học **PP369** (Phản ứng tại các mốc bội số của 3 dựa theo giá đầu tháng/đầu năm), kết hợp với:

- **WebSocket Realtime Price Feed**: Nhận giá Mark Price tức thì cho hơn 400+ cặp giao dịch USDT-M.
- **Confluence Scorer (Hệ thống chấm điểm)**: Kết hợp xu hướng khung H4/H1, nến nảy M15/M5 và khối lượng giao dịch.
- **Dynamic Risk & Position Sizing**: Tự động tính đòn bẩy an toàn theo khoảng cách lưới và quy định mức ký quỹ mục tiêu theo điểm tín hiệu.
- **Smart Trailing SL & Virtual Safeguards**: Dời Stop Loss về hòa vốn khi đạt mục tiêu ROI ban đầu, kết hợp TP/SL ảo bảo vệ vị thế trước biến động giá cực nhanh.
- **AI Dataset Collector**: Tự động thu thập dữ liệu giao dịch (Entry, Exit, Score, Reasons, Holding time, PnL) phục vụ huấn luyện mô hình Machine Learning.

---

## 2. KIẾN TRÚC THƯ MỤC VÀ TỆP CỐT LÕI

```
369futures/
├── ecosystem.config.js       # File cấu hình quản lý tiến trình PM2 (Fork mode, Memory limits)
├── package.json              # Khai báo dependency (axios, ws, dotenv)
├── .env                      # File biến môi trường (Binance API Key, Telegram Bot Token, Trade Amounts)
├── MO_TA_CHI_TIET_369FUTURES.md # Tài liệu mô tả kiến trúc chi tiết toàn bộ dự án
├── data/                     # Thư mục lưu trữ dữ liệu cache & dataset
│   ├── step_sizes.json       # Cache bước giá (stepSize, tickSize, h4Cache, leverageInfo)
│   ├── active_trades.json    # Cache metadata các vị thế đang chạy real-time
│   ├── ai_trade_dataset.jsonl# Dataset thu thập các lệnh vào/ra phục vụ huấn luyện AI
│   ├── 369_signals.jsonl     # Lịch sử ghi log tất cả tín hiệu quét được
│   └── grid_blacklist.json   # Danh sách các coin bị tự động đưa vào blacklist do lỗi sàn
├── scripts/                  # Thư mục chứa các kịch bản chạy & công cụ backtest
│   ├── auto-trade.js         # Entrypoint chính để khởi chạy Bot AutoTrade qua PM2
│   ├── backtest_pp369.js     # Tool backtest chiến lược PP369
│   ├── backtest_m1_pp369.js  # Tool backtest trên nến M1 chi tiết
│   ├── dashboard.js          # Dashboard thống kê hiệu suất giao dịch
│   └── rebacktest_with_time.js # Tool kiểm tra lại dữ liệu nến thực tế theo timestamp
└── src/
    ├── pp369/                # Module lõi phân tích chiến lược 369
    │   ├── core.js           # Engine toán học 369, tính lưới mốc, scoring, roundtrip, trend
    │   ├── stream.js         # Quản lý kết nối Binance WebSocket Stream & REST price update
    │   ├── formatter.js      # Định dạng tin nhắn báo hiệu Telegram đẹp mắt
    │   ├── telegram.js       # Mô-đun gửi tin nhắn Telegram API
    │   ├── datasetCollector.js# Mô-đun ghi nhận entry/exit cho Dataset AI
    │   ├── signalTracker.js  # Thống kê các tín hiệu bị bỏ qua và lý do
    │   └── signalLog.js      # Ghi log lịch sử tín hiệu ra file JSONL
    └── trader/               # Module tương tác sàn & quản lý giao dịch
        ├── binance.js        # REST API Wrapper Binance Futures (Market, Limit, Algo Order, Leverage)
        └── autoTrade.js      # Vòng lặp giao dịch tự động, quản lý lệnh chờ, Trailing SL, Virtual TP/SL
```

---

## 3. PHƯƠNG PHÁP & THUẬT TOÁN 369 (PP369 CORE)

### 3.1. Khái niệm Mốc Gốc (Origin Levels) & Lưới Mốc (Grid Levels)

Chiến lược dựa trên quy luật phản ứng giá tại các bội số của 3 so với giá đầu năm/đầu tháng:

1. **Lấy mốc gốc**: Giá Open và Close của nến **H4** đầu tiên lúc `00:00 UTC` ngày 01/01/2026 (được lưu trong `h4Cache`).
2. **Tạo 2 dãy mốc**:
   - **Dãy mốc trên (`tren`)**: Bắt đầu từ `Math.max(Open, Close)` cộng dần từng **Bước (Step)** $\rightarrow$ Dùng cho mốc **LONG Entry**.
   - **Dãy mốc dưới (`duoi`)**: Bắt đầu từ `Math.min(Open, Close)` trừ dần từng **Bước (Step)** $\rightarrow$ Dùng cho mốc **SHORT Entry**.

### 3.2. Bảng Bước Giá (Price Step Rules)

Bước giá ($\text{Step}$) được tính tự động dựa trên **mức giá hiện tại** của coin (đảm bảo độ rộng lưới luôn phù hợp ngay cả khi coin biến động 10x):

| Mức giá hiện tại | Đơn vị ($\text{Unit}$) | Bước giá ($\text{Step} = \text{Unit} \times 3$) | % Grid/Price tương đương |
| :--- | :--- | :--- | :--- |
| $\ge \$10,000$ | $1,000$ | $3,000$ | $\approx 3\%$ (BTC) |
| $\$1,000 - \$9,999$ | $100$ | $300$ | $3\% - 30\%$ (ETH) |
| $\$100 - \$999$ | $10$ | $30$ | $3\% - 30\%$ (BNB) |
| $\$10 - \$99$ | $1$ | $3$ | $3\% - 30\%$ (SOL, AVAX) |
| $\$1 - \$9.99$ | $0.1$ | $0.3$ | $3\% - 30\%$ (UNI, NEAR) |
| $\$0.20 - \$0.99$ | $0.01$ | $0.03$ | $1.5\% - 15\%$ (ADA, XRP) |
| $\$0.02 - \$0.19$ | $0.001$ | $0.003$ | $1.5\% - 15\%$ |
| $< \$0.02$ | $0.0001 \dots$ | $0.0003 \dots$ | $1.5\% - 15\%$ |

### 3.3. Thuật toán Roundtrip & Trạng thái Lần Chạm (`lastSide`)

- **Độ cận cận & Ngưỡng kích hoạt**:
  - **Lọc sơ bộ WebSocket (`PROXIMITY_PCT`)**: Tự động tính theo khoảng cách lưới (`0.75% - 2.0%`) để giữ theo dõi các coin đang tiến về mốc.
  - **Ngưỡng đặt lệnh (`NEAR_LEVEL_PCT = 0.3%`)**: Kích hoạt phát tín hiệu và phát lệnh LIMIT đón sẵn khi giá nằm trong khoảng $\le 0.3\%$ tính từ mốc.
- **Trạng thái `lastSide`**:
  - **Tín hiệu LONG**: Kích hoạt khi giá chạm mốc `tren` (ở phía DƯỚI giá), và lần chạm mốc hoàn chỉnh gần nhất phải là mốc trên (`lastSide === 'upper'`). Điều này đảm bảo giá đang quay đầu từ mốc trên đi xuống mốc dưới.
  - **Tín hiệu SHORT**: Kích hoạt khi giá chạm mốc `duoi` (ở phía TRÊN giá), và lần chạm mốc gần nhất phải là mốc dưới (`lastSide === 'lower'`).
- **Phân tích Nến M1 Đã Đóng**: Quét toàn bộ lịch sử nến 1m từ đầu năm/tháng (loại bỏ nến đang hình thành cuối cùng) để đếm chính xác số lần `roundtrip` chạm mốc:
  - **Lần 1**: Độ mạnh `strong` (+2.0 điểm).
  - **Lần 2**: Độ mạnh `medium` (+1.0 điểm).
  - **Lần 3+**: Độ mạnh `weak` (+1.0 điểm).

### 3.4. Bộ Lọc An Toàn (Safety Filters)

1. **Bộ lọc Độ rộng Grid (`isGridWidthValid`)**:
   - Tỷ lệ $\text{GridStepPct} = \frac{\text{Step}}{\text{Price}} \times 100\%$.
   - Coin thường: Độ rộng phải nằm trong khoảng **$3\% - 30\%$**.
   - Coin Top 100 Market Cap: Cho phép độ rộng từ **$1.5\% - 30\%$**.
2. **Danh sách Đen Grid (`grid_blacklist.json`)**: Tự động loại bỏ các coin bị sàn trả về lỗi đặc thù (ví dụ `-4411` leverage không hỗ trợ).
3. **Tiêu chí 2 (Volatility Safety Filter)**:
   - Kiểm tra biên độ nến H1 và nến M15 gần nhất.
   - Nếu nến H1 biến động vượt quá $\text{GridStepPct} \times 2.5$ hoặc có nến xả/bơm dị biệt $\rightarrow$ **Bỏ qua tín hiệu** để tránh bắt dao rơi.

### 3.5. Quy Trình Lấy và Lọc Mã Theo Dõi (Symbol Selection & Monitoring Workflow)

Quy trình tự động phát hiện, lọc và theo dõi danh sách mã trên Binance Futures được thực hiện qua **5 bước liên hoàn**:

```
[1. REST API ExchangeInfo] → Lấy toàn bộ 470+ cặp USDT-M trên Binance
             ↓
[2. Cache H4 Đầu Năm]      → Lấy nến H4 (01/01 00:00 UTC), tính Step & Lưới Mốc
             ↓
[3. Filter Grid Width]     → Lọc % Grid theo Giá Tức Thời (Top100: 2-25%, Khác: 3-25%)
             ↓
[4. Blacklist Check]       → Loại bỏ coin vi phạm quy tắc lưới hoặc lỗi API sàn (-4411)
             ↓
[5. Realtime WS & Proximity] → Kết nối WebSocket Stream 1s, chỉ scan coin sát mốc <= 0.1%
```

1. **Bước 1: Tải danh sách giao dịch từ Binance Futures**:
   - Gọi API `/fapi/v1/exchangeInfo` lấy toàn bộ danh sách các cặp Futures hợp lệ (đuôi `USDT`, bỏ các cặp giao dịch theo quý `_`).
   - Lưu thông tin `stepSize` (đơn vị khối lượng) và `tickSize` (đơn vị giá) vào `data/step_sizes.json`.
2. **Bước 2: Nạp Nến H4 Đầu Năm (`initH4Cache`)**:
   - Với mỗi mã coin, Bot kiểm tra nến H4 lúc `00:00 UTC` ngày 01/01/2026 trong `h4Cache`.
   - Nếu chưa có, Bot gửi request (delay `200ms/coin` chống ban IP) để nạp giá `openPrice`, `closePrice` và tính `Step` lưới.
3. **Bước 3: Lọc theo Độ Rộng Lưới Hiện Tại (`isGridWidthValid`)**:
   - Cập nhật **Mark Price** tức thời của tất cả coin.
   - Tính tỷ lệ: $\text{GridStepPct} = \frac{\text{Step}}{\text{Current Price}} \times 100\%$.
   - **Coin Top 100 MarketCap**: Chỉ giữ lại các coin có $\text{GridStepPct}$ từ **$2\% - 25\%$**.
   - **Các coin còn lại**: Chỉ giữ lại các coin có $\text{GridStepPct}$ từ **$3\% - 25\%$**.
   - *(Loại bỏ coin biến động quá hẹp gây phát tín hiệu ảo hoặc biến động quá rộng nguy hiểm)*.
4. **Bước 4: Loại bỏ mã trong Danh sách Đen**:
   - Loại bỏ coin bị đưa vào `grid_blacklist.json` (tự động khóa 7 ngày khi lưới bị méo).
   - Loại bỏ coin bị sàn trả về lỗi đòn bẩy `-4411`.
5. **Bước 5: Lọc tiệm cận Real-time qua WebSocket Stream (`NEAR_LEVEL_PCT = 0.3%`)**:
   - Mở WebSocket Stream `/ws/!markPrice@arr@1s` nhận giá realtime 1 giây/lần cho toàn bộ 470+ coin hợp lệ.
   - Khi giá nằm trong khoảng **$0.75\% - 2\%$** tính từ mốc, Socket giữ coin đó trong bộ nhớ theo dõi.
   - Khi giá tiến vào khoảng **$\le 0.3\%$** sát mốc, Bot lập tức gửi coin đó vào **Confluence Scorer** để chấm điểm và đặt lệnh `LIMIT GTC` đón sẵn trên orderbook Binance! (Giúp tối ưu 99% CPU và băng thông mà không bị trễ lệnh).

---

## 4. HỆ THỐNG ĐÁNH ĐIỂM HỘI TỤ (CONFLUENCE SCORER)

Mỗi tín hiệu phát ra được chấm điểm theo thang tổng hợp (Scorer) từ **0.0 đến 10.0+ điểm**. Chỉ các lệnh đạt **Score $\ge 6.0$ điểm** mới đủ điều kiện cho AutoTrader kích hoạt đặt lệnh.

### Cơ cấu cộng điểm:

1. **Điểm Cơ Sở PP369**:
   - Lần chạm 1 (`strong`): **+2.0 điểm**.
   - Lần chạm 2 (`medium`) hoặc Lần 3+ (`weak`): **+1.0 điểm**.
2. **Điểm Xu Hướng H4 / H1 (Trend Confluence)**:
   - Thuận xu hướng cả H4 và H1: **+3.0 điểm**.
   - H4 thuận, H1 đi ngang: **+2.0 điểm**.
   - H4 thuận, H1 ngược (pullback trong trend lớn): **+1.0 điểm**.
   - Ngược H4: **-1.5 điểm** (Phạt lệnh ngược trend trung hạn).
3. **Điểm Nến Đảo Chiều (Candle Reversal Signal)**:
   - Rút chân mạnh trên M15/M5 (râu nến $\ge 40\%$ chiều dài nến): **+1.5 đến +2.0 điểm**.
   - Nến chìm thế (Engulfing) hoặc Pinbar: **+1.0 đến +1.5 điểm**.
4. **Điểm Phụ Kèm Theo**:
   - Giá tiệm cận cực sát mốc ($< 0.05\%$): **+0.5 điểm**.
   - Khối lượng nến đảo chiều tăng vọt (Volume Spike): **+1.0 điểm**.

---

## 5. LUỒNG XỬ LÝ & ĐẶT LỆNH TỰ ĐỘNG (AUTOTRADER EXECUTION)

### 5.1. Khởi chạy & Khởi tạo Cache (`scripts/auto-trade.js`)

1. Đọc danh sách coin từ `data/step_sizes.json`.
2. Đồng bộ nến **H4** đầu năm 2026 (`initH4Cache`).
3. Lấy tỷ giá mới nhất qua REST API để lọc coin có % grid nằm trong khoảng $3\% - 30\%$.
4. Gửi thông báo khởi động lên Telegram (`notifyBotStart`).
5. Gọi Binance API lấy thông tin đòn bẩy tối đa (`loadLeverageBrackets`) và bắt đầu vòng lặp giao dịch `startAutoTrade`.

### 5.2. Tính Đòn bẩy & Ký quỹ Mục tiêu (Dynamic Margin & Leverage)

- **Đòn bẩy Động (`effectiveLeverage`)**: Đảm bảo khoảng cách SL $= 1 \text{ Unit} = \frac{\text{Step}}{3}$ luôn bằng đúng **$-13\%$ Margin**:
  $$\text{Calculated Leverage} = \lfloor \frac{39}{\text{GridStepPct}} \rfloor$$
  $$\text{Effective Leverage} = \max(1, \min(\text{Calculated Leverage}, \text{Max Allowed by Binance}))$$
- **Ký quỹ Mục tiêu (Target Margin)** theo Điểm Score:
  - Score $\ge 9.0$đ: Ký quỹ **$50 USDT**.
  - Score $\ge 8.0$đ: Ký quỹ **$40 USDT**.
  - Score $\ge 7.0$đ: Ký quỹ **$30 USDT**.
  - Score $< 7.0$đ (từ 6.0 - 6.9đ): Ký quỹ **$20 USDT** (hoặc cấu hình mặc định `.env`).
- **Khối lượng đặt lệnh (`qty`)**:
  $$\text{Target Notional} = \text{Target Margin} \times \text{Effective Leverage}$$
  $$\text{Qty} = \text{Quantize}(\frac{\text{Target Notional}}{\text{Target Level}}, \text{stepSize})$$

### 5.3. Luồng Đặt Lệnh & Quản Lý Lệnh Treo (Pending Limits & Bounce Cancel)

1. **Đặt Lệnh Chờ (`LIMIT GTC`)**: Bot đặt lệnh LIMIT mua/bán tại đúng mốc `Target Level`.
2. **Luồng `checkPendingOrders` / `checkPendingLimits` (Chạy mỗi 3s)**:
   - **Limit Timeout**: Nếu lệnh LIMIT treo quá 3 phút mà chưa khớp $\rightarrow$ Tiến hành hủy lệnh để giải phóng vốn.
   - **Bounce Cancel**: Nếu giá chạm vùng entry rồi bật đi xa ($\ge \text{stepPct} / 5.5$) $\rightarrow$ Tiến hành hủy lệnh LIMIT để tránh bị khớp lại ở vị thế xấu (stale fill).

### 5.4. Luồng Quản Lý Vị Thế Mở (Trailing SL, Virtual TP / Virtual SL)

Chạy mỗi 5 giây (`checkTrailingSL`):

#### Quy tắc TP / SL / Trailing SL theo Đơn Vị Bước Giá ($\text{Unit} = \frac{\text{Step}}{3}$):

- **Đơn vị cơ sở**: $\text{Unit} = \frac{\text{Step}}{3}$ (Ví dụ: giá $\$5.086$ có $\text{Step} = 0.300 \rightarrow \text{Unit} = 0.100$).
- **Mốc Stop Loss (SL)**: 
  * $\text{SL Price} = \text{Entry} \pm \text{Unit}$ (Giữ nguyên cho mọi tầng điểm, chuẩn **$-13\%$ Margin** với đòn bẩy $\lfloor \frac{39}{\text{GridStepPct}} \rfloor$).
- **Mốc Take Profit (TP)** theo 3 Tầng Điểm Score:
  * **Score $< 7.0$đ (hoặc Ngược Trend)**: $\text{TP Distance} = \text{Unit} \times 0.9$ (90 ticks khi step=300, ví dụ $+0.090 \rightarrow \text{TP} = 5.176$).
  * **Score $< 8.0$đ ($7.0 - 7.9$đ)**: $\text{TP Distance} = \text{Unit} \times 1.2$ (120 ticks khi step=300, ví dụ $+0.120 \rightarrow \text{TP} = 5.206$).
  * **Score $\ge 8.0$đ ($\ge 8.0$đ)**: $\text{TP Distance} = \text{Unit} \times 1.5$ (150 ticks khi step=300, ví dụ $+0.150 \rightarrow \text{TP} = 5.236$).
- **Mốc Dời Trailing SL (Khóa Lãi)**:
  * $\text{Trail Trigger Distance} = \text{Unit} \times 0.45$ (**Cố định 45 ticks** khi step=300 cho **tất cả các thang điểm Score**, ví dụ $+0.045$ với giá $5.086 \rightarrow \text{Trigger} = 5.131$).
  * Khi giá chạm mốc này, Bot lập tức dời SL trên sàn về mốc **Entry $+ 5$đ** ($\text{Unit} \times 0.05$, tương đương $+5$ ticks tùy theo bước giá; ví dụ $+0.005$ với giá $5.086 \rightarrow \text{SL Mới} = 5.091$).

#### Cơ chế Virtual TP & Virtual SL (Bảo vệ Kép):
- Trong mọi chu kỳ quét WebSocket, nếu ROI vượt quá `tpPct` hoặc sụt quá `slPct`, Bot tự động đóng vị thế bằng lệnh **MARKET** ngay lập tức, phòng trường hợp sàn Binance bị nghẽn API hoặc giá quét nhanh rút râu.

### 5.5. Cơ chế Bảo vệ Metadata Vị Thế (`activeTradesMetadata`)

Để tránh lỗi mất thông tin điểm Score khi lệnh LIMIT khớp một phần (Partial Fill):
- Luồng `checkPendingOrders` và `checkPendingLimits` được trang bị bộ kiểm tra `hasOpenPosition` / `lastActivePositions.has(sym)`.
- Nếu vị thế đã khớp và đang mở trên Binance, luồng Bounce Cancel **tuyệt đối không được xóa** `activeTradesMetadata[sym]`, đảm bảo luồng Trailing SL giữ nguyên Score gốc và chạy đúng mốc trigger $+5\%$ ROI.

### 5.6. Chiến Lược H1 Retest Cho Các Mã Score Thấp (`lowScoreWatchlist`)

Nhằm không bỏ lỡ cơ hội ở các mã có điểm Scorer chưa đủ lớn ($\text{Score} < 5.5$đ):

1. **Watchlist theo dõi**: Các mã bị loại ban đầu do điểm thấp được đưa vào `lowScoreWatchlist`.
2. **Kiểm tra Nến H1 Đóng Cửa (Phút 00 mỗi giờ - `checkH1RetestSignals`)**:
   - Tải 60 nến 1M của giờ H1 vừa đóng.
   - Kiểm tra nến H1 rút chân/rút râu tại Entry ($\text{Low} \le \text{Entry}$ VÀ $\text{Close} > \text{Entry}$ với LONG).
   - Quét chuỗi nến 1M từ thời điểm chạm Entry đầu tiên:
     - Nếu đã phản ứng nảy $\text{ROI} \ge +5\%$ $\rightarrow$ Bỏ qua (sóng đã chạy).
     - Nếu chưa nảy đủ $+5\%$ ROI $\rightarrow$ **ĐẶT LỆNH LIMIT TẠI ENTRY** (Ký quỹ $\$20$).
3. **Hủy Lệnh Chờ**: Nếu lệnh LIMIT đang chờ mà giá chạy vọt $\text{ROI} \ge +5\%$ mà chưa khớp $\rightarrow$ Luồng Bounce Cancel tự động hủy lệnh LIMIT ngay lập tức.

---

## 6. HỆ THỐNG THU THẬP DỮ LIỆU AI (DATASET COLLECTOR)

File `src/pp369/datasetCollector.js` chịu trách nhiệm thu thập toàn bộ vòng đời giao dịch và ghi vào file `data/ai_trade_dataset.jsonl` theo định dạng JSON Lines:

### 1. Khi lệnh vào (`recordTradeEntry`):
Lưu lại: `tradeId`, `symbol`, `signal`, `entryPrice`, `markPrice`, `score`, `scoreReasons`, `marketCapRank`, `leverage`, `margin`, `timestamp`.

### 2. Khi lệnh đóng (`recordTradeExit`):
Cập nhật: `exitPrice`, `exitTimestamp`, `exitType` (`TP`, `SL`, `TRAILING_SL`, `BOUNCE_CANCEL`, `LIMIT_TIMEOUT`), `pnlPercent`, `pnlUsd`, `holdingDurationMinutes`, `isWin`.

> **Mục đích**: Dữ liệu này được tích lũy liên tục để huấn luyện (train) các mô hình AI/ML đánh giá hiệu suất tín hiệu trong tương lai.

---

## 7. TÍCH HỢP TELEGRAM & CẤU HÌNH VẬN HÀNH (PM2)

### Telegram Notifier (`src/pp369/telegram.js` & `formatter.js`)
- Phát thông báo đẹp mắt mỗi khi có Signal PP369 mới.
- Báo hiệu trạng thái khởi động Bot, số lượng coin đang theo dõi.
- Báo hiệu khi dời SL về hòa vốn, chốt lời (TP), cắt lỗ (SL), hoặc hủy lệnh chờ.

### Quản lý Tiến trình PM2 (`ecosystem.config.js`)
Bot được vận hành dưới dạng tiến trình chạy ẩn qua PM2 với các tham số tối ưu tài nguyên:
- **`script`**: `./scripts/auto-trade.js`
- **`exec_mode`**: `fork` (Tiết kiệm RAM).
- **`node_args`**: `--max-old-space-size=256` (Ép Garbage Collector dọn rác khi RAM chạm 256MB).
- **`max_memory_restart`**: `450M` (Tự khởi động lại nếu rò rỉ bộ nhớ vượt 450MB).
- **`autorestart`**: `true` (Tự khôi phục ngay lập tức nếu gặp sự cố mạng/crash).

---
*Tài liệu được khởi tạo tự động bởi Antigravity AI Assistant.*
