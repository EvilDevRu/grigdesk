# ОПЦИОНАЛЬНО. Обычно фронт отдаёт сам сервер кокпита (@fastify/static) — этот образ
# нужен ТОЛЬКО когда UI хостится отдельно от мозга (напр. VPS-витрина): статика в nginx,
# ходит на мозг по VITE_BRAIN_URL, заданному на этапе сборки.
#   docker build -t cockpit-web --build-arg VITE_BRAIN_URL=http://100.x.y.z:8140 .
#   docker run -p 8080:80 cockpit-web
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
ARG VITE_BRAIN_URL=""
ENV VITE_BRAIN_URL=$VITE_BRAIN_URL
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
