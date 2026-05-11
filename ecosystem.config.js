module.exports = {
  apps: [{
    name: 'mlb-server',
    script: 'index.js',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    }
  }]
}
