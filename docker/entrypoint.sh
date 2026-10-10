#!/bin/sh
set -e

# 默认参数
APP_LANG=${APP_LANG:-en}
APP_PORT=${APP_PORT:-8090}

echo "Current Configuration:"
echo " - Language:  $APP_LANG"
echo " - Port:      $APP_PORT"

# 动态修改 Nginx 监听端口
sed -i "s/listen 80;/listen ${APP_PORT};/g" /etc/nginx/conf.d/default.conf

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

# 启动 nginx
exec nginx -g "daemon off;"
