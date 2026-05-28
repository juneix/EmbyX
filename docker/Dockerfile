# Dockerfile for EmbyX
# --- 阶段一: 使用 Golang 编译后台中转服务 ---
FROM golang:alpine AS builder
WORKDIR /build
COPY live/main.go .
# 纯标准库项目，无需 go.mod 即可直接编译出无依赖的微型二进制包
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o embyx-proxy main.go

# --- 阶段二: 还原您原本的 Nginx Alpine 运行环境 ---
FROM nginx:alpine
WORKDIR /app

# 从 builder 拷贝极轻量 Go 运行包，零污染、无任何额外 Python 依赖
COPY --from=builder /build/embyx-proxy /app/embyx-proxy

# 复制中英文版本到镜像内部存放
COPY zh/ /app/dist/zh/
COPY en/ /app/dist/en/

# 复制 nginx 配置
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

# 复制并设置启动脚本
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 预设默认语言和端口环境变量
ENV APP_LANG=en
ENV APP_PORT=8090
ENV LIVE_PORT=8091

# EXPOSE 在 host 模式下仅作声明
EXPOSE 8090
EXPOSE 8091

# 使用自定义脚本启动
ENTRYPOINT ["/entrypoint.sh"]
