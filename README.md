# Club Equipment Lending

## Cài và kiểm tra từ thư mục gốc

Cần Node.js 26 trở lên, npm, Microsoft SQL Server và Caddy để mở giao diện qua HTTPS.

Trên Windows, nếu có nhiều bản cài Node.js, chạy `Get-Command node,npm -All` và đặt thư mục cài Node.js 26 cùng npm đi kèm lên đầu `PATH` của terminal trước khi cài và kiểm thử.

```powershell
npm ci
npm test
npm run build
```

`npm test` kiểm tra API HTTP bằng dữ liệu tổng hợp, gồm chặn khách và từ chối thành viên gọi trực tiếp handler quản lý. `npm run build` kiểm tra cú pháp JavaScript của ứng dụng và chép giao diện vào `dist/`.

## Chạy bản demo

1. Tạo database SQL Server riêng `ClubEquipmentLending_Preview` và cấp cho tài khoản demo quyền chạy migration và thao tác trên database này. Đặt `DATABASE_URL` bằng chuỗi kết nối SQL Server dành cho demo. Nếu dùng shared memory trên Windows, đặt thêm `SQLSERVER_DRIVER=odbc` và dùng chuỗi ODBC. Xem [hướng dẫn backend](backend/README.md).
2. Trong PowerShell đã cấu hình kết nối, chạy các lệnh sau. Thay hai giá trị mật khẩu bằng mật khẩu tổng hợp do bạn chọn. Seed giữ nguyên mật khẩu của tài khoản đã tồn tại.

   ```powershell
   $env:LENDING_ENV = 'demo'
   $env:DEMO_MEMBER_PASSWORD = 'synthetic-member-demo'
   $env:DEMO_MANAGER_PASSWORD = 'synthetic-manager-demo'
   npm run migrate
   npm run seed
   $env:APP_ORIGIN = 'https://localhost:8443'
   $env:HOST = '127.0.0.1'
   $env:PORT = '3000'
   npm start
   ```

3. Từ thư mục gốc, mở terminal khác và chạy `caddy run --config Caddyfile`. Cấu hình phục vụ `dist/` và chuyển tiếp API về cổng 3000 trên cùng origin. Nếu trình duyệt chưa tin cậy CA nội bộ của Caddy, chạy `caddy trust` với quyền phù hợp rồi mở `https://localhost:8443/`.
4. Mở trực tiếp `/#equipment` và `/#management` khi chưa đăng nhập. Đăng nhập lần lượt bằng `demo.member` và `demo.manager`, kiểm tra hai mã thiết bị `DEMO-01` và `DEMO-02`, tải lại trang rồi đăng xuất. Thành viên thấy thông báo thiếu quyền tại màn Quản lý. Xem [kịch bản kiểm tra giao diện](frontend/README.md).

## Kiểm thử với SQL Server

Đặt `TEST_DATABASE_URL` trỏ tới database riêng `ClubEquipmentLending_Test` với quyền tạo và xóa schema thử nghiệm. Nếu dùng ODBC, đặt `SQLSERVER_DRIVER=odbc`. Chạy `npm run test:sqlserver` từ thư mục gốc để kiểm tra migration, seed lặp lại, hai ID thiết bị và vòng đời phiên. Dùng dữ liệu tổng hợp cho cả database demo và test.

## Xác minh SQL Server trên máy điều hành

Xem [kết quả kiểm thử tích hợp](story-111-sqlserver-verification.md).
