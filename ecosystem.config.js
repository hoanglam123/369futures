module.exports = {
  apps: [
    {
      name: '369futures-bot',
      script: './scripts/auto-trade.js',
      exec_mode: 'fork',           // Chạy chế độ fork đơn giản, tiết kiệm tài nguyên
      node_args: '--max-old-space-size=384 --expose-gc', // Dọn rác (GC) tối ưu ở mốc 384MB cho VPS 768MB + chủ động GC
      instances: 1,
      autorestart: true,           // Tự động khởi động lại nếu crash
      watch: false,                // Không cần watch file thay đổi trong production
      max_memory_restart: '450M',  // Tránh bị PM2 diệt nhầm khi vừa nạp dữ liệu đĩa
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
