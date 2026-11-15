# Bàn giao backend Story #111

## Khởi tạo

Cần Node.js 26 trở lên và một cơ sở dữ liệu Microsoft SQL Server. Chạy lệnh trong thư mục backend. Mặc định, driver dùng TCP với chuỗi kết nối SQL Server của mssql. Windows dùng shared memory có thể đặt SQLSERVER_DRIVER=odbc và cung cấp chuỗi ODBC trong DATABASE_URL.

1. Chạy `npm install`.
2. Cấu hình `DATABASE_URL` và chạy `npm run migrate`.
3. Với demo/test, đặt `LENDING_ENV` thành `demo` hoặc `test`, cấp hai mật khẩu tổng hợp qua `DEMO_MEMBER_PASSWORD` và `DEMO_MANAGER_PASSWORD`, rồi chạy `npm run seed`. Seed giữ nguyên ID, vai trò và mật khẩu của các bản ghi đã tồn tại. Tài khoản mẫu là `demo.member` và `demo.manager`.
4. Đặt `APP_ORIGIN` thành origin HTTPS công khai, ví dụ `https://lending.example.test`, rồi chạy `npm start`. Đặt FE và API sau cùng một reverse proxy kết thúc TLS. API mặc định lắng nghe tại `127.0.0.1:3000`, có thể cấu hình bằng `HOST` và `PORT`.

## Tích hợp FE

| API | Yêu cầu và phản hồi |
| --- | --- |
| `POST /auth/login` | Gửi JSON `{ username, password }` từ origin ứng dụng. Nhận `200` với `{ id, username, role, csrf_token }` và cookie phiên. |
| `GET /auth/me` | Nhận `200` với cùng cấu trúc. Gọi khi mở hoặc tải lại màn nghiệp vụ. |
| `GET /equipment` | Nhận `200` với mảng JSON chứa `{ id, asset_code, name }`. Dùng `asset_code` để phân biệt hai máy chiếu và dùng `id` để liên kết lịch Story #112. |
| `POST /auth/logout` | Gửi header `X-CSRF-Token` lấy từ login hoặc me. Nhận `204` với body rỗng. |

Trình duyệt gửi cookie qua yêu cầu cùng origin. Cookie `__Host-lending_session` có `Secure`, `HttpOnly`, `SameSite=Lax` và thời hạn cố định 8 giờ. Giữ `csrf_token` trong bộ nhớ FE và gửi qua `X-CSRF-Token` cho các lệnh ghi có phiên.

Lỗi có cấu trúc `{ code }`. Với `401 AUTH_REQUIRED`, FE xóa dữ liệu phiên và điều hướng về đăng nhập, kể cả khi mở thẳng màn nghiệp vụ. Với `403 FORBIDDEN`, giữ phiên và báo thiếu quyền. Với `403 CSRF_INVALID`, tải lại `/auth/me` để lấy token hiện hành. Điều hướng quản lý dựa trên vai trò `MANAGER`. Danh mục có thể trả mảng rỗng.

Đăng nhập trả `400 INVALID_INPUT` nếu dữ liệu thiếu hoặc sai định dạng, `401 INVALID_CREDENTIALS` cho cả tên và mật khẩu sai, `403 ORIGIN_FORBIDDEN` nếu sai origin, và `429 LOGIN_RATE_LIMITED` kèm `Retry-After` tính bằng giây. Giới hạn trong mỗi tiến trình là 10 lần gửi mỗi phút theo IP khách.

Caddy ghi đè `X-Lending-Client-IP` bằng IP của kết nối tới Caddy. API chỉ dùng header chứa một IP hợp lệ từ kết nối TCP có nguồn `127.0.0.1`. Các trường hợp khác dùng IP của kết nối tới API. Khi triển khai theo `Caddyfile`, giữ API trên loopback và cho khách truy cập qua Caddy. Cấu hình này tin cậy tiến trình cục bộ có thể kết nối từ `127.0.0.1`.

Các route nghiệp vụ đăng ký qua `routes` của `createApp` đều yêu cầu phiên. Route quản lý đặt `role: 'MANAGER'` để kiểm tra quyền trước khi chạy handler. Kiểm tra CSRF tự áp dụng cho lệnh ghi. Hai mã `DEMO-01` và `DEMO-02` có ID vật lý riêng. API lịch thuộc Story #112 và lệnh duyệt cùng giao dịch khóa theo thiết bị thuộc Story #114.

## Kiểm thử

- `npm test` chạy kiểm thử HTTP với kho dữ liệu thử nghiệm trong bộ nhớ.
- `npm run test:sqlserver` chạy migration, seed hai lần và kiểm thử HTTP với Microsoft SQL Server. Đặt `TEST_DATABASE_URL` trỏ tới DB kiểm thử dùng dữ liệu tổng hợp. Tài khoản DB cần quyền tạo schema thử nghiệm. Bộ kiểm thử tạo và dọn schema riêng.

### SQL Server kiểm thử trên máy Windows

Dùng database riêng ClubEquipmentLending_Test. Tài khoản Windows có quyền tạo schema test; kết nối shared memory qua ODBC Driver 17. Đặt SQLSERVER_DRIVER=odbc và TEST_DATABASE_URL thành chuỗi ODBC phù hợp với máy. Không dùng database vận hành. Bài test đã chạy trên SQL Server thật và đã dọn schema sinh ra.
