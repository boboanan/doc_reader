#!/bin/bash
cd "$(dirname "$0")"
echo "📖 启动 Doc Reader..."
echo ""

# 等待服务启动后自动打开浏览器
(sleep 2 && open "http://localhost:3456") &

node server.js --scan-dir "$(dirname "$PWD")"
