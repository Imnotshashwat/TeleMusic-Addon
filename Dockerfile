FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY index.js tracks_cache.json* ./

EXPOSE 3000

CMD ["node", "index.js"]
