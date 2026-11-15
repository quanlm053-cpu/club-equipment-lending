# Chạy thử giao diện Story #111

1. Dùng cơ sở dữ liệu SQL Server dành cho demo/test. Chạy migration và seed theo [hướng dẫn backend](../backend/README.md), đặt hai mật khẩu tổng hợp qua `DEMO_MEMBER_PASSWORD` và `DEMO_MANAGER_PASSWORD`.
2. Khởi động API với `APP_ORIGIN=https://localhost:8443` và cổng mặc định `3000`.
3. Phục vụ thư mục `frontend` và chuyển tiếp API trên cùng origin HTTPS. Ví dụ với Caddy, lưu nội dung sau vào một Caddyfile cục bộ ở thư mục gốc dự án rồi chạy `caddy run --config Caddyfile` từ đó.

   ```caddyfile
   https://localhost:8443 {
       tls internal
       @api path /auth/* /equipment
       handle @api {
           reverse_proxy 127.0.0.1:3000
       }
       handle {
           root * ./frontend
           file_server
       }
   }
   ```

   Dùng chứng chỉ mà trình duyệt tin cậy. Với Caddy cục bộ, có thể dùng `caddy trust` để cài CA nội bộ khi tài khoản có quyền. Truy cập `https://localhost:8443/`.

## Kiểm tra

- Mở trực tiếp `/#equipment` và `/#management` trong cửa sổ riêng tư. Cả hai đưa khách về đăng nhập.
- Dùng nút điền tên `demo.member` rồi nhập mật khẩu đã seed. Thử mật khẩu sai trước. Đăng nhập đúng sẽ hiển thị hai máy chiếu với mã `DEMO-01` và `DEMO-02`. Mở `/#management` để kiểm tra thông báo thiếu quyền và liên kết về danh mục.
- Đăng xuất và đăng nhập bằng `demo.manager`. Mục Quản lý xuất hiện. Mở mục này và tải lại trang để kiểm tra phiên. Đăng xuất rồi mở lại liên kết quản lý để kiểm tra việc chặn truy cập.
- Dùng công cụ mạng của trình duyệt để chặn riêng `GET /equipment` trong lúc điều hướng từ màn Quản lý sang Danh mục. Bỏ chặn rồi bấm **Thử lại**. Phản hồi `200` với `[]` hiển thị trạng thái danh mục trống. Phản hồi `401` khi đang đăng nhập đưa người dùng về màn đăng nhập với thông báo hết phiên.
- Chạy `npm test` trong `backend` để kiểm tra thành viên gọi trực tiếp handler quản lý nhận `403`. Chạy `npm run test:sqlserver` theo README backend để kiểm tra seed, hai ID vật lý và vòng đời phiên trên SQL Server.

Danh mục giữ ID vật lý từ API cho luồng lịch ở Story #112. Màn quản lý hiển thị quyền truy cập và thông tin về hàng đợi thuộc Story #114.

## Kết quả kiểm tra Task #120

- Chrome qua HTTPS đạt với API backend và kho dữ liệu tổng hợp trong bộ nhớ. Đã kiểm tra hai vai trò, đường dẫn trực tiếp, tải lại trang, phiên hết hạn, danh mục đang tải, rỗng, lỗi và thử lại, lỗi đăng xuất, làm mới CSRF và thu hồi phiên.
- `node --check frontend/app.js` và bộ kiểm thử HTTP của backend đạt. Handler quản lý thử nghiệm trả `403` cho thành viên trước khi thực thi.
- Theo kết quả người điều hành ghi trên Redmine #120, Chrome đã kiểm tra bản preview tại `localhost:3102` với cơ sở dữ liệu SQL Server demo riêng `ClubEquipmentLending_Preview`. Cả `demo.member` và `demo.manager` đều đăng nhập được, thấy `DEMO-01` và `DEMO-02`, giữ phiên khi tải lại và trở về màn đăng nhập khi đăng xuất. Lượt này chạy ngoài sandbox vì driver ODBC native không khả dụng trong sandbox.
