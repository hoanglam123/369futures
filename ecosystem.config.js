module.exports = {
  apps: [
    {
      name: '369futures-bot',
      script: './scripts/auto-trade.js',
      instances: 1,
      autorestart: true, // Tự động khởi động lại nếu crash
      watch: false,      // Không cần watch file thay đổi trong production
      max_memory_restart: '300M', // Khởi động lại nếu vượt quá 300MB RAM
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
