module.exports = {
  apps: [
    {
      name: 'threads-smart-bot',
      cwd: __dirname,
      script: 'dist/index.js',
      interpreter: 'node',
      instances: 1,
      autorestart: true,
      restart_delay: 10000,
      kill_timeout: 30000,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
