#!/bin/sh
set -e

# 默认参数
APP_LANG=${APP_LANG:-en}
APP_PORT=${APP_PORT:-8090}
LIVE_PORT=${LIVE_PORT:-8091}

echo "Current Configuration:"
echo " - Language:  $APP_LANG"
echo " - Port:      $APP_PORT"
echo " - Live Port: $LIVE_PORT"

# 动态修改 Nginx 监听端口
sed -i "s/listen 80;/listen ${APP_PORT};/g" /etc/nginx/conf.d/default.conf

# 动态修改 Nginx 反向代理 Go 后端的端口
sed -i "s/127.0.0.1:8091/127.0.0.1:${LIVE_PORT}/g" /etc/nginx/conf.d/default.conf

# 清理 web 根目录
rm -rf /usr/share/nginx/html/*

# 根据环境变量选择性“部署”
if [ "$APP_LANG" = "zh" ]; then
    echo "Deploying Chinese version..."
    cp -rf /app/dist/zh/* /usr/share/nginx/html/
else
    echo "Deploying English version..."
    cp -rf /app/dist/en/* /usr/share/nginx/html/
fi

# 启动 Go 语言直播中转后台守护进程 (绑定 8091)
/app/embyx-proxy &

# 启动 nginx
exec nginx -g "daemon off;"
