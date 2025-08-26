module.exports = {
  apps: [
    {
      name: "2eat-backend",
      script: "index.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        BACKEND_PUBLIC_URL: "https://2eatapp.com",
        SSL_KEY_PATH: "/etc/ssl/private/cloudflare.key",
        SSL_CERT_PATH: "/etc/ssl/certs/cloudflare.crt",
        GOOGLE_API_KEY: process.env.GOOGLE_API_KEY
      }
    }
  ]
}
