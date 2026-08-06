# BỘ QUY TẮC IPDA & MÔ HÌNH ENTRY CHUYÊN SÂU (INTERBANK PRICE DELIVERY ALGORITHM)

Bộ quy tắc giao dịch IPDA (Thuật toán Phân phối Giá Liên ngân hàng) giúp định hướng dòng tiền tổ chức, xác định vùng thanh khoản 20D-40D-60D và kích hoạt entry chuẩn xác.

---

## 1. THUẬT TOÁN IPDA VÀ CÁC CẤP ĐỘ THANH KHOẢN (20D - 40D - 60D)
- **IPDA 20D (Ngắn hạn - 1H/4H)**: Mức thanh khoản 20 ngày gần nhất (20D High = BSL, 20D Low = SSL). Là mục tiêu thanh khoản ngắn hạn năng động.
- **IPDA 40D (Trung hạn - 4H/Daily)**: Mức tham chiếu hàng quý của tổ chức (40D High = BSL, 40D Low = SSL). Khi mốc 20D bị quét (Sweep), giá sẽ mở rộng đà di chuyển đến 40D.
- **IPDA 60D (Dài hạn - Daily/Weekly)**: Mức tham chiếu vĩ mô lớn (60D High = BSL, 60D Low = SSL). Quét mốc 60D báo hiệu điểm đảo chiều hoặc sóng đẩy vĩ mô cực mạnh.
- **Quy luật Thanh khoản**: Giá luôn được lập trình di chuyển đến Đỉnh BSL (Buy Side Liquidity) hoặc Đáy SSL (Sell Side Liquidity) trước khi tiếp tục xu hướng hoặc đảo chiều.

---

## 2. NHẬN DIỆN HƯỚNG ĐI IPDA (BÒ VS GẤU)
- **Xu hướng Bò IPDA (Bullish IPDA)**: Giá xóa SSL (Đáy 20D), giữ cấu trúc tăng và hướng tới mục tiêu Đỉnh 20D High / 40D High (BSL). Giá đóng cửa nằm trên BSL xác nhận đà tăng tiếp diễn.
- **Xu hướng Gấu IPDA (Bearish IPDA)**: Giá xóa BSL (Đỉnh 20D), giữ cấu trúc giảm và hướng tới mục tiêu Đáy 20D Low / 40D Low (SSL). Giá đóng cửa nằm dưới SSL xác nhận đà giảm tiếp diễn.

---

## 3. MÔ HÌNH ENTRY THEO IPDA & LTF CHOCH
- **Bước 1 (Vùng Thanh Khoản)**: Xác định mốc IPDA chưa bị quét (SSL/BSL chưa chạm) làm mục tiêu hướng đến.
- **Bước 2 (Xác nhận Đảo chiều LTF CHoCH)**: Chờ hiện tượng CHoCH (Change of Character - Phá vỡ cấu trúc Swing High/Low) ở khung nhỏ LTF (15M/1H).
- **Bước 3 (Vùng Entry Lý Tưởng OTE / FVG)**: Vào lệnh tại vùng OTE (Optimal Trade Entry) hoặc FVG (Fair Value Gap / Khung khoảng trống giá) sau khi có CHoCH.
- **Bước 4 (Chốt lời BSL/SSL & Quản trị Rủi ro)**: 
  - TP1: Đỉnh/Đáy 20D (BSL/SSL 20D). Dời SL về Hòa vốn khi đạt TP1.
  - TP2: Đỉnh/Đáy 40D (BSL/SSL 40D).
  - TP3: Đỉnh/Đáy 60D (BSL/SSL 60D).
