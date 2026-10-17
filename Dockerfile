# お試し版（Cloud Run）用のイメージ。依存ライブラリはないので、必要なファイルだけをコピーする
FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app
COPY package.json server.js ./
COPY lib/ ./lib/
COPY routes/ ./routes/
COPY public/ ./public/
COPY --chown=node:node data/ ./data/
# data/ はガイドさんページの編集やログで書き込むため、実行ユーザー（node）が書けるようにする
RUN mkdir -p /app/data/logs && chown -R node:node /app/data
USER node
EXPOSE 8080
CMD ["node", "server.js"]
