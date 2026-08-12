module.exports = {
  apps: [
    {
      name: '369futures-bot',
      script: './scripts/auto-trade.js',
      exec_mode: 'fork',           // Chạy chế độ fork đơn giản, tiết kiệm tài nguyên
      node_args: '--max-old-space-size=256', // Khống chế Node.js dọn rác (GC) khi chạm 256MB
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
