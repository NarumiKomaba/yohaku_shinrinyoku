# お試し版（Cloud Run）用のイメージ。依存ライブラリはないので、必要なファイルだけをコピーする
FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app
COPY package.json server.js ./
COPY lib/ ./lib/
COPY routes/ ./routes/
COPY public/ ./public/
# 記録と Spot は Firestore に置く（STORE_BACKEND=firestore）。イメージには書き換えない同梱データだけを読み取り専用で入れる
COPY data/knowledge.json data/scenario.json ./data/
USER node
EXPOSE 8080
CMD ["node", "server.js"]
