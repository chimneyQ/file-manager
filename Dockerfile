FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

# 先装依赖，最大化利用构建缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

COPY . .

# 运行期数据目录（建议用 volume 挂出去，否则容器删除即丢失）
RUN mkdir -p /app/uploads /app/logs /app/.trash
VOLUME ["/app/uploads", "/app/logs"]

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/login',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]

