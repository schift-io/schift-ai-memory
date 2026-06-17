FROM node:22-slim

ENV NODE_ENV=production \
    SCHIFT_MCP_TRANSPORT=http \
    PORT=8080

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY dist ./dist

EXPOSE 8080

CMD ["node", "dist/cli.js", "--http"]
