FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
EXPOSE 4003
# --import runs tracing.js before the app, which is what lets
# OpenTelemetry patch http/express/pg/redis/amqplib as they load.
# The ESM loader hook it needs is registered inside tracing.js.
CMD ["node", "--import", "./src/tracing.js", "src/index.js"]
