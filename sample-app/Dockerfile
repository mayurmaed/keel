FROM node:20-alpine
WORKDIR /app
COPY package.json server.mjs ./
RUN npm install --omit=dev
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
