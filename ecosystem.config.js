module.exports = {
  apps: [{
    name: 'chick-game',
    script: 'chicken-road-server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 8001
    }
  }]
}