// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "2eat-backend",
      script: "index.js",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 10,

      // Default (dev) env--env production
      env: {
        NODE_ENV: "development",
        PORT: "3000",
        BACKEND_PUBLIC_URL: "http://localhost:3000",
        RECS_SERVICE_URL: "http://127.0.0.1:8000",
        GOOGLE_API_KEY: process.env.GOOGLE_API_KEY || ""
      },

      // Production env — use with: pm2 start ... --env production
      env_production: {
        NODE_ENV: "production",
        BACKEND_PUBLIC_URL: "https://2eatapp.com",
        RECS_SERVICE_URL: "http://127.0.0.1:8000",
        // HTTPS certs (your real paths)
        SSL_KEY_PATH: "/home/ubuntu/certs/cloudflare.key",
        SSL_CERT_PATH: "/home/ubuntu/certs/cloudflare.crt",
        // Optional fallback HTTP port if HTTPS init fails
        PORT: "3000",
        GOOGLE_API_KEY: process.env.GOOGLE_API_KEY || ""
      }
    }
  ]
}
