# LỘ TRÌNH KỸ THUẬT: FIBONACCI HYBRID SL 3 TẦNG & PERSISTENT DEEP CACHE CHO BOT-H4
*(Nội địa hóa tư duy Quant Trading của Claude vào mã nguồn bot-h4: Tự động hóa 100%, 0 Token, 0ms Latency)*

---

## 1. TỔNG QUAN VẤN ĐỀ & BÀI HỌC TỪ THỰC CHIẾN

### 1.1. Căn bệnh "Cận thị" của Bot-H4 (Short-Sightedness)
* Trong mã nguồn hiện tại ([core.js dòng 698-847](file:///f:/LamDH/Project/369futures/src/pp369/core.js#L698-L847) và [autoTrade.js dòng 938-948](file:///f:/LamDH/Project/369futures/src/trader/autoTrade.js#L938-L948)):
  * Nến H1 chỉ lưu tối đa **100 nến** ($\approx 4.1$ ngày), chỉ quét 90 nến.
  * Nến H4 chỉ lưu tối đa **75 nến** ($\approx 12.5$ ngày), chỉ quét 45 nến.
  * Nến D1 chỉ lưu **45 nến**, và **hoàn toàn KHÔNG được sử dụng** để tìm cản trong `calculateTierSLTP`.
* **Hậu quả:** Cứ khi nào giá phá đỉnh/đáy của tuần trước (sau 7 ngày), bot bị rơi vào **vùng mù hoàn toàn (Blind Zone)** $\rightarrow$ Báo `PA_0_LEVEL (0 cản cũ)`.

### 1.2. Hậu quả của con số trần cơ học $3.5\%$
* Khi rơi vào vùng mù `PA_0_LEVEL`, bot-h4 tự động "kẹp trần" mức SL cứng tại $3.5\%$.
* Mức $3.5\%$ này là một **con số cơ học trôi nổi giữa không trung**:
  * **Với SOLV:** Khi nến xả thủng đáy 7 ngày, bot đặt SL tại `$0.003956` ($3.51\%$). Nhưng trong lịch sử 2 tháng trước (nến ngày 11/10 và 23/09), vùng hỗ trợ cứng thực sự nằm ở **`$0.003895 - $0.003946`**. Giá rơi về `$0.003934` liếm sạch SL của bot rồi mới rút chân đảo chiều $\rightarrow$ **Bị quét SL oan uổng**!
  * **Với ICNT:** Khi giá pump mạnh, bot đặt SL tại `$0.3523` ($3.53\%$). Mức SL này quá chật so với biên độ nến ATR $3.87\%$, khiến tỷ lệ R:R bị méo mó.

---

## 2. TRỤ CỘT 1: KIẾN TRÚC PERSISTENT DEEP CANDLE CACHE (LƯU BỀN VỮNG JSON)

Thay vì phụ thuộc vào việc gọi API liên tục hoặc chỉ lưu tạm trong RAM, toàn bộ nến lịch sử sâu sẽ được **lưu trữ bền vững vào các file JSON trên đĩa cứng**:

```
[KHỞI ĐỘNG SERVER / PM2 RESTARTS]
               │
               ▼
   1. Đọc ngay từ file JSON trên đĩa vào RAM (0ms)
      - data/h1_history_cache.json (300 nến H1 ≈ 12.5 ngày)
      - data/h4_history_cache.json (300 nến H4 ≈ 50 ngày, gần 2 tháng)
      - data/d1_history_cache.json (180 nến D1 ≈ 6 tháng)
               │
               ▼
   2. Kiểm tra khoảng trống thời gian (Gap Check):
      - missingCount = (currentTime - lastClosedTime) / interval
      - NẾU missingCount == 0: XONG, 0 API calls!
      - NẾU missingCount > 0: Chỉ gọi ĐÚNG các nến bị thiếu trong lúc bot tắt!
               │
               ▼
   3. Suốt quá trình quét tín hiệu & tính lệnh (Runtime):
      - 100% ĐỌC TỪ RAM CACHE (0ms, 0 API calls, 0 weight).
      - Khi cây nến mới đóng cửa: Chỉ nối thêm 1 nến vào đuôi mảng và ghi file JSON.
```

### Thông số kỹ thuật nâng cấp Cache:

| Khung | Số nến cũ | Số nến MỚI | Thời gian bao quát | Dung lượng đĩa (400 coin) |
| :---: | :---: | :---: | :---: | :---: |
| **H1** | 100 | **300 nến** | $\approx 12.5$ ngày | $\sim 15\text{ MB}$ |
| **H4** | 75 | **300 nến** | $\approx 50$ ngày ($> 1.5$ tháng) | $\sim 15\text{ MB}$ |
| **D1** | 45 | **180 nến** | $\approx 6$ tháng | $\sim 9\text{ MB}$ |
| **Tổng**| - | - | - | **$\sim 39\text{ MB}$ (Cực nhẹ)** |

---

## 3. TRỤ CỘT 2: MÔ HÌNH HYBRID SL 3 TẦNG THÔNG MINH

*(Đã lược bỏ Tầng 4 Soft Invalidation theo đúng chỉ đạo: Bot-H4 đã có sẵn các cơ chế dời TP về Entry, Breakeven Lock và Fractal Trailing SL M5 khi phát hiện nguy hiểm).*

```
                               [TÍN HIỆU ENTRY 369]
                                        │
                                        ▼
    ┌───────────────────────────────────────────────────────────────────────┐
    │ TẦNG 1: CẢN SWEET SPOT H1 / H4 GẦN                                    │
    │ Quét Swing S/R trên H1 (300 nến) và H4 (150 nến).                     │
    │ ĐIỀU KIỆN: Khoảng cách cản nằm trong [1.2x ATR, 2.0x ATR] (<= 3.5%)   │
    │ └──> Đặt SL nép sau Cản S/R + 0.2% buffer an toàn.                    │
    └───────────────────────────────────────────────────────────────────────┘
                                        │ (Không có cản H1/H4 gần)
                                        ▼
    ┌───────────────────────────────────────────────────────────────────────┐
    │ TẦNG 2: CẢN D1 TẦM TRUNG (LỊCH SỬ 6 THÁNG)                            │
    │ Quét Swing S/R trên D1 (180 nến).                                     │
    │ ĐIỀU KIỆN: Khoảng cách cản D1 nằm trong biên độ cho phép              │
    │            (<= 2.2x ATR hoặc <= 4.0%)                                 │
    │ └──> Đặt SL nép sau Cản D1 + 0.2% buffer an toàn.                     │
    └───────────────────────────────────────────────────────────────────────┘
                                        │ (Cản D1/H4 ở QUÁ XA > 2.2x ATR hoặc > 4.0%)
                                        ▼
    ┌───────────────────────────────────────────────────────────────────────┐
    │ TẦNG 3: CẢN ĐỘNG FIBONACCI (GIẢI PHÁP ĐỈNH/ĐÁY Ở XA)                 │
    │ KHÔNG dùng cản xa, KHÔNG dùng trần 3.5% cơ học.                       │
    │ Lựa chọn 3A: FIBONACCI RETRACEMENT TRÊN SÓNG ĐẨY H1 GẦN NHẤT          │
    │   - SHORT: SL nép sau Fib 0.786 + 0.2% buffer.                        │
    │   - LONG:  SL nép sau Fib 0.786 - 0.2% buffer.                        │
    │ Lựa chọn 3B (Fallback nếu sóng phẳng): FIBONACCI GOLDEN ATR           │
    │   - Khoảng cách SL = min(1.618 * ATR, 3.2%).                          │
    │ └──> SL luôn được khóa gọn trong [2.2% - 3.2%].                       │
    │      TP (R:R >= 1.5) chỉ cần [3.3% - 4.8%] -> RẤT DỄ CHẠM TP!         │
    └───────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
                        [CHỐT CHẶN AN TOÀN TUYỆT ĐỐI]
        - Sàn tối thiểu (minSlPct): 1.3% Tier 1, 1.8% Tier 2 Altcoin.
        - Khóa rủi ro vốn: Margin x Leverage x SL% = TargetLossUSD ($3.00).
```

---

## 4. TRỤ CỘT 3: CƠ CHẾ CÀI ĐẶT TP THÔNG MINH (S/R & 369 GRID ANCHORED TP)

### 4.1. Lỗ hổng của cơ chế cài TP hiện tại:
* Trong `autoTrade.js` hiện tại: $\text{targetTpDist} = \text{slDist} \times 1.50 \rightarrow \text{TP} = \text{Entry} \pm \text{targetTpDist}$.
* Đây là phép nhân cơ học mù quáng:
  1. **Bị cản chặn đầu:** Nếu cản đối diện cứng nằm ở $+3.5\%$, nhưng phép nhân $1.5\text{R}$ lại rơi vào $+4.2\%$ $\rightarrow$ Giá chạm $+3.5\%$ dội ngược đảo chiều, lệnh không bao giờ chạm TP $\rightarrow$ Biến lệnh thắng thành hòa vốn hoặc thua!
  2. **Chốt non (Ăn hạt thóc, bỏ bao gạo):** Nếu cản đối diện hoặc mốc ô lưới 369 nằm ở $+6.5\%$ ($R:R = 2.5$), nhưng bot chỉ đặt TP ở $+3.75\%$ ($1.5\text{R}$) $\rightarrow$ Bỏ lỡ con sóng nảy lớn của thị trường.

### 4.2. Cơ chế Cài TP Mới: 3 Nguyên Tắc Cốt Lõi:
1. **Nguyên tắc 1: Neo theo Cản Đối Diện & Mốc Lưới 369 (S/R & Grid Anchored)**:
   * **Với lệnh LONG:** Quét tìm các ngưỡng Kháng cự đối diện (Resistance H4/D1) và mốc lưới 369 kế tiếp phía trên (`entryPrice + step369`).
   * **Với lệnh SHORT:** Quét tìm các ngưỡng Hỗ trợ đối diện (Support H4/D1) và mốc lưới 369 kế tiếp phía dưới (`entryPrice - step369`).
2. **Nguyên tắc 2: Kỹ thuật Front-Running TP (Đi trước cản một bước)**:
   * Không đặt lệnh TP Limit đúng đỉnh/đáy cản (vì cá mập thường xả trước đỉnh khiến ta bị kẹt lệnh không khớp).
   * Đặt TP lùi lại một khoảng đệm an toàn buffer ($0.2\% - 0.3\%$):
     $$\text{TP}_{\text{LONG}} = \text{TargetResistance} - (\text{Entry} \times 0.002)$$
     $$\text{TP}_{\text{SHORT}} = \text{TargetSupport} + (\text{Entry} \times 0.002)$$
3. **Nguyên tắc 3: Phân Biệt Cản Cứng vs Cản Yếu & Cơ Chế Bỏ Qua Cản Yếu (Weak S/R Bypass)**:
   * **Định nghĩa Cản Yếu (Minor/Weak S/R):**
     * Đỉnh/đáy râu nến H1 đơn lẻ (`touches == 1`).
     * Hoặc cản nằm quá sát Entry (khoảng cách $< 1.0\text{x ATR}$).
     * Đây là những cản dễ bị xuyên phá khi xu hướng đang có xung lực.
   * **Định nghĩa Cản Cứng (Major/Strong S/R):**
     * Cản H4 có `touches >= 2` HOẶC Cản D1 (Khung Ngày) HOẶC Mốc ô lưới 369.
     * Đây mới là những "bức tường bê tông" thực sự có khả năng làm giá đảo chiều.
   * **Thuật toán xử lý khi gặp cản yếu có $R:R < 1.5$ (Tránh Reject Oan Uổng):**
     * **TUYỆT ĐỐI KHÔNG REJECT LỆNH** chỉ vì vướng một cản yếu H1 ở cự ly gần!
     * Thuật toán kích hoạt cơ chế **Bypass (Nhìn xuyên qua cản yếu)**: Tự động bỏ qua cản yếu đó, đặt mục tiêu TP vươn tới **CẢN CỨNG TIẾP THEO (hoặc Mốc Lưới 369 kế tiếp)** để đạt $R:R \ge 1.5$ hoặc $2.0\text{R}$.
     * **Bảo hiểm an toàn:** Được bảo vệ bởi **mốc 35% TP**: Khi giá chạm cản yếu đó mà bị rung lắc, mốc 35% đã kịp kéo SL về Breakeven (Hòa vốn). Nếu giá xuyên thủng cản yếu $\rightarrow$ Lệnh tiếp tục phi thẳng tới Cản Cứng để ăn trọn lợi nhuận!
   * **Điều kiện DUY NHẤT để Bot REJECT (Veto) Lệnh:**
     * Chỉ bấm VETO khi **BỨC TƯỜNG CẢN CỨNG THỰC SỰ** (H4/D1 $\text{touches} \ge 2$ hoặc Mốc 369) chặn ngay đầu khiến khoảng cách tới cản cứng đó không đủ đạt $R:R \ge 1.48$. Lúc này việc từ chối lệnh là hoàn toàn chính xác để tránh đâm đầu vào tường đá!

### 4.3. Quản lý Vị thế Động khi Lệnh đang chạy (Active Position Management):
* **Cột mốc 35% Quãng đường TP:** Kéo SL về Breakeven (Entry $+ 1\%$ phí) để loại trừ $100\%$ rủi ro cháy/âm vốn.
* **Cột mốc 70% Quãng đường TP:** Kích hoạt Fractal Trailing SL M5/H1 bám sát đáy/đỉnh sóng để khóa chặt phần lớn lợi nhuận.
* **Cơ chế Phòng vệ (Defensive Escape):** Nếu thị trường phát hiện BTC Flash Dump hoặc đảo chiều dòng tiền $\rightarrow$ Kéo TP về sát Entry để thoát vị thế an toàn.

---

## 5. CHI TIẾT TỪNG TẦNG THỰC THI TOÁN HỌC

### 5.1. Tầng 1: Cản Sweet Spot (H1 / H4)
* **Logic:** Khi thị trường đang chạy trong kênh giá sideway hoặc có sóng điều chỉnh rõ ràng:
  * Điểm Pivot gần nhất của H1/H4 nằm cách Entry một khoảng $d \ge 1.2 \times \text{ATR}$ (đủ thoát khỏi vùng nhiễu nến) và $d \le 2.0 \times \text{ATR}$ (không vượt quá $3.5\%$).
* **Công thức SL:**
  * Lệnh LONG: $\text{SL} = \text{Support}_{\text{pivot}} - (\text{Entry} \times 0.002)$
  * Lệnh SHORT: $\text{SL} = \text{Resistance}_{\text{pivot}} + (\text{Entry} \times 0.002)$

### 5.2. Tầng 2: Cản D1 Tầm Trung (Khung Ngày)
* **Logic:** Dùng khi giá vừa phá vỡ các đỉnh/đáy nhỏ của tuần, nhưng vẫn nằm trước một cản lớn trên khung Ngày (D1).
* **Điều kiện áp dụng:** Cản D1 có khoảng cách tới Entry $\le \min(2.2 \times \text{ATR}, \; 4.0\%)$.
* **Bảo vệ:** Được bảo hiểm bằng cơ chế **Giảm đòn bẩy động (Dynamic Leverage)**: Nếu cản D1 cách $4.0\%$, đòn bẩy tự động giảm xuống $2\text{x}$ để số tiền lỗ khi chạm SL vẫn bảo toàn đúng $\$3.00$ USD.

### 5.3. Tầng 3: Cản Động Fibonacci (Khi Đỉnh/Đáy ở xa hoặc Phá vỡ Kỷ lục)
* **Vấn đề giải quyết:** Khi coin dò đỉnh mới (như ICNT pump) hoặc dò đáy mới (như SOLV dump), cản cũ ở tít $8\% - 15\%$.
* **Thuật toán Fibonacci Retracement trên sóng đẩy H1:**
  1. Xác định đỉnh sóng gần nhất ($High_{H1}$) và đáy sóng gần nhất ($Low_{H1}$) trong 24 nến H1 gần nhất.
  2. Biên độ sóng: $\Delta = High_{H1} - Low_{H1}$.
  3. Mức Fibonacci Thoái lui $0.786$:
     * Với SHORT: $\text{Fib}_{0.786} = Low_{H1} + 0.786 \times \Delta$
     * Với LONG: $\text{Fib}_{0.786} = High_{H1} - 0.786 \times \Delta$
  4. Nếu Entry nằm giữa vùng $0.5 - 0.618$: SL nép ngay sau mốc $0.786 \pm 0.2\%$ buffer.
* **Thuật toán Fallback Fibonacci Golden ATR ($1.618\text{x ATR}$):**
  * Nếu nến không tạo sóng đẩy rõ ràng:
    $$\text{slDist} = \min\big(\max(1.618 \times \text{ATR}, \; \text{minSlPct}), \; 3.2\%\big)$$
  * SL luôn nằm trong vùng "vừa vặn": Không quá hẹp để bị quét râu, không quá rộng để làm biến dạng mục tiêu TP.

---

## 6. KẾ HOẠCH TRIỂN KHAI 4 BƯỚC CỤ THỂ

| Bước | Hạng mục công việc | Tệp tin chỉnh sửa | Kết quả đầu ra |
| :---: | :--- | :--- | :--- |
| **BƯỚC 1** | **Nâng cấp Persistent Cache H1/H4/D1**<br>- Tăng limit cache: H1 (300), H4 (300), D1 (180).<br>- Tối ưu hàm đọc/ghi đĩa JSON bền vững.<br>- Bổ sung hàm seed nến tự động không block luồng. | [src/pp369/core.js](file:///f:/LamDH/Project/369futures/src/pp369/core.js) | Cache lưu bền vững vào file JSON, khởi động lại PM2 không mất dữ liệu, quét lệnh 0ms. |
| **BƯỚC 2** | **Tích hợp Cản D1 & Module Fibonacci Hybrid SL**<br>- Nạp D1 vào danh sách Pivot candidates.<br>- Viết hàm tính sóng Fibonacci Retracement 0.786.<br>- Xây dựng bộ điều hướng 3 tầng trong `calculateTierSLTP`. | [src/trader/autoTrade.js](file:///f:/LamDH/Project/369futures/src/trader/autoTrade.js) | Xóa bỏ hoàn toàn trần cứng 3.5% vô căn cứ. Tự động chuyển tầng mượt mà. |
| **BƯỚC 3** | **Kiểm thử tự động toàn diện (Test Suites)**<br>- Viết test case cho cả 3 tầng (Sweet spot, Cản D1, Dò đỉnh/đáy Fib).<br>- Test lại ca thực tế ICNT và SOLV.<br>- Xác nhận tỷ lệ R:R $\ge 1.5$ đạt chuẩn. | [tests/test_fibonacci_hybrid_sl.js](file:///f:/LamDH/Project/369futures/tests/) | Bộ kiểm thử đạt 100% PASS, không có lỗi ngoại lệ. |
| **BƯỚC 4** | **Đồng bộ Roadmap & Triển khai VPS**<br>- Commit git lên nhánh `refac-bot-new` và merge vào `main`.<br>- Cập nhật tài liệu hướng dẫn vận hành. | Toàn bộ repository | Sẵn sàng đưa vào chạy thực tế trên máy chủ. |

---

## 7. TIÊU CHÍ NGHIỆM THU (ACCEPTANCE CRITERIA)
1. **Bộ nhớ Cache:** Khi restart PM2, thời gian tải dữ liệu nến cho 400 coin $< 500\text{ms}$ từ đĩa, số lượng request API tới Binance $= 0$ (nếu không thiếu nến).
2. **Loại bỏ hoàn toàn trần 3.5% mù quáng:** Không còn bất kỳ vị thế nào có SL bị kẹp cứng vô căn cứ ở $3.5\%$ khi đỉnh/đáy ở xa.
3. **Đạt chuẩn R:R $\ge 1.5$:** Mọi lệnh sinh ra đều có mục tiêu TP khả thi ($3.0\% - 5.0\%$) tương ứng với SL ($1.8\% - 3.2\%$).
4. **Không bị AI Veto:** Các setup sinh ra đều có điểm tựa kỹ thuật rõ ràng (Cản thực tế hoặc Fibonacci $0.786$).
