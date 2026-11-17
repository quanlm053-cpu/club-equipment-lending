# Chạy thử giao diện mượn thiết bị

1. Dùng cơ sở dữ liệu SQL Server dành cho demo/test. Chạy migration và seed theo [hướng dẫn backend](../backend/README.md), đặt hai mật khẩu tổng hợp qua `DEMO_MEMBER_PASSWORD` và `DEMO_MANAGER_PASSWORD`.
2. Khởi động API với `APP_ORIGIN=https://localhost:8443` và cổng mặc định `3000`.
3. Từ thư mục gốc dự án chạy `npm run build`, sau đó chạy `caddy run --config Caddyfile`. [Caddyfile](../Caddyfile) phục vụ bản build trong `dist` và chuyển tiếp các API phiên, danh mục và lịch trên cùng origin HTTPS.

   Dùng chứng chỉ mà trình duyệt tin cậy. Với Caddy cục bộ, có thể dùng `caddy trust` để cài CA nội bộ khi tài khoản có quyền. Truy cập `https://localhost:8443/`.

## Kiểm tra

- Mở trực tiếp `/#equipment` và `/#management` trong cửa sổ riêng tư. Cả hai đưa khách về đăng nhập.
- Dùng nút điền tên `demo.member` rồi nhập mật khẩu đã seed. Thử mật khẩu sai trước. Đăng nhập đúng sẽ hiển thị hai máy chiếu với mã `DEMO-01` và `DEMO-02`. Mở `/#management` để kiểm tra thông báo thiếu quyền và liên kết về danh mục.
- Đăng xuất và đăng nhập bằng `demo.manager`. Mục Quản lý xuất hiện. Mở mục này và tải lại trang để kiểm tra phiên. Đăng xuất rồi mở lại liên kết quản lý để kiểm tra việc chặn truy cập.
- Dùng công cụ mạng của trình duyệt để chặn riêng `GET /equipment` trong lúc điều hướng từ màn Quản lý sang Danh mục. Bỏ chặn rồi bấm **Thử lại**. Phản hồi `200` với `[]` hiển thị trạng thái danh mục trống. Phản hồi `401` khi đang đăng nhập đưa người dùng về màn đăng nhập với thông báo hết phiên.
- Chạy `npm test` trong `backend` để kiểm tra thành viên gọi trực tiếp handler quản lý nhận `403`. Chạy `npm run test:sqlserver` theo README backend để kiểm tra seed, hai ID vật lý và vòng đời phiên trên SQL Server.

## Kiểm tra lịch trống Story #112

1. Đăng nhập bằng tài khoản demo và bấm **Xem lịch** ở DEMO-01. Kiểm tra thiết bị chọn sẵn theo mã tài sản và nhãn **Asia/Bangkok (UTC+07:00)** ở cả bộ nhập và kết quả. Hai trường giờ bắt đầu trống.
2. Với fixture tổng hợp AC1 trong [SRS](../story-112-srs.md), tra ngày 16/11/2026 từ 09:00 đến 13:00. Kết quả DEMO-01 là 11:00–13:00. Đổi sang DEMO-02 và tra lại để thấy 09:00–13:00. DEMO-01 từ 09:00 đến 11:00 báo không có giờ trống. Tra lại bằng tài khoản quản lý để kiểm tra quyền.
3. Đổi múi giờ trình duyệt sang America/Los_Angeles và kiểm tra mốc gửi tương ứng 02:00Z và 06:00Z. Tra qua đêm và kiểm tra ngày ở cả hai mốc. Bỏ trống, nhập trùng hoặc đảo mốc để kiểm tra lỗi cạnh trường, tiêu điểm và việc không gửi yêu cầu.
4. Làm chậm phản hồi lịch rồi đổi đầu vào và tra lượt mới. Kết quả chỉ phản ánh lượt mới. Chặn API lịch rồi bỏ chặn để thử nút **Thử lại**. Với 401, màn đăng nhập xuất hiện và lịch được xóa. Với 403, màn hình báo thiếu quyền. Với 404, **Tải lại danh mục** mở danh mục và tải các thiết bị hiện có.
5. Với fixture đầy đủ trong SRS, tra DEMO-01 từ 06:00 đến 15:00. Kiểm tra ba khoảng theo thứ tự 06:00–07:00, 11:00–13:00 và 14:00–15:00. Kiểm tra phản hồi API và màn hình bằng cả hai vai trò để xác nhận cùng kết quả và không có dữ liệu người mượn. Trên DB kiểm thử, đổi lượt 10:00–11:00 từ `HANDED_OVER` sang `RETURNED` rồi tra lại. Khoảng 11:00–13:00 mở rộng thành 10:00–13:00.

6. Với thiết bị demo có lịch trống toàn bộ, tra từ 09:00 ngày 16/11/2026 đến 09:00 ngày 16/11/2126 theo giờ CLB. Kiểm tra cả cửa sổ tra cứu và dòng kết quả đều hiện `09:00 16/11/2026 → 09:00 16/11/2126`.

### Kết quả Task #136

- Chrome headless qua HTTP cục bộ đã kiểm tra bản build với handler backend và kho dữ liệu tổng hợp trong bộ nhớ. Đã kiểm tra màn 360 px, múi giờ America/Los_Angeles, giá trị UTC gửi đi, lịch qua ngày và phần giây, đổi thiết bị trong khi tải, lượt cũ về sau, lịch bận toàn bộ, lỗi nhập, lỗi danh mục, thử lại sau 500, phản hồi 401/403/404 và tra cứu bằng hai vai trò.
- Lượt kiểm tra lại đạt `npm run build`, `npm test` (3/3) và `git diff --check`.
- Dùng kết quả SQL Server do bộ điều phối chạy ngoài sandbox trên cùng checkout, đạt 1/1 theo log `1794747349026653300-story-112-sqlserver.log`. Bài kiểm tra gồm migration, phiên, fixture lịch tổng hợp, khoảng bận chồng và nối tiếp, dữ liệu lịch trả về cho hai vai trò và việc giải phóng giờ khi chuyển sang đã trả.
- Xác minh trình duyệt qua Caddy HTTPS với cơ sở dữ liệu kiểm thử thuộc lượt kiểm tra triển khai. Caddy chưa có trên PATH trong môi trường này.

## Kết quả kiểm tra Task #120

- Chrome qua HTTPS đạt với API backend và kho dữ liệu tổng hợp trong bộ nhớ. Đã kiểm tra hai vai trò, đường dẫn trực tiếp, tải lại trang, phiên hết hạn, danh mục đang tải, rỗng, lỗi và thử lại, lỗi đăng xuất, làm mới CSRF và thu hồi phiên.
- `node --check frontend/app.js` và bộ kiểm thử HTTP của backend đạt. Handler quản lý thử nghiệm trả `403` cho thành viên trước khi thực thi.
- Theo kết quả người điều hành ghi trên Redmine #120, Chrome đã kiểm tra bản preview tại `localhost:3102` với cơ sở dữ liệu SQL Server demo riêng `ClubEquipmentLending_Preview`. Cả `demo.member` và `demo.manager` đều đăng nhập được, thấy `DEMO-01` và `DEMO-02`, giữ phiên khi tải lại và trở về màn đăng nhập khi đăng xuất. Lượt này chạy ngoài sandbox vì driver ODBC native không khả dụng trong sandbox.
