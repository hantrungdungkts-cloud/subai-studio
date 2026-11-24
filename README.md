# SubAI Studio Web (100% Static — GitHub Pages Ready)

Ứng dụng tạo & dịch phụ đề video tự động chạy **100% trực tiếp trên trình duyệt** (không cần server backend, không cần API Key, tắt máy tính vẫn dùng online 24/7 trên điện thoại & PC).

## Công nghệ sử dụng
- **Whisper AI in-browser** (`@huggingface/transformers` chạy trong Web Worker)
- **Dịch phụ đề miễn phí** (Google GTX + MyMemory fallback)
- **Lưu dự án trực tiếp trên thiết bị** (IndexedDB)
- **Xuất / Nhập file phụ đề** `.SRT`, `.VTT`, `.ASS`
- **Giao diện Mobile & PC**, xoay màn hình 90°, toàn màn hình, cài được dạng PWA
