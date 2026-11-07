FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
USER node
EXPOSE 7443
CMD ["node", "src/supervisor.ts"]
