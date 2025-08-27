module.exports = {
  apps: [
    {
      name: "2eat-backend",
      script: "index.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        USE_LOCAL_TLS: "1", // <— enable local TLS in index.js
        SSL_KEY_PATH: "/home/ubuntu/certs/cloudflare.key",
        SSL_CERT_PATH: "/home/ubuntu/certs/cloudflare.crt",
        PORT: "3000",
        BACKEND_PUBLIC_URL: "https://2eatapp.com",
        GOOGLE_API_KEY: process.env.GOOGLE_API_KEY || ""
      }
    }
  ]
}
