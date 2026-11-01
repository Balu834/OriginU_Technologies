# Build from the missed-call-textback folder (the gateway reuses lib/crypto.mjs
# and lib/qrSigning.mjs from the app):
#   fly deploy . --config qr-gateway/fly.toml --dockerfile qr-gateway/Dockerfile
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY qr-gateway/package.json qr-gateway/package-lock.json qr-gateway/
RUN cd qr-gateway && npm ci --omit=dev && npm cache clean --force

COPY lib/crypto.mjs lib/qrSigning.mjs lib/
COPY qr-gateway/server.mjs qr-gateway/
COPY qr-gateway/lib qr-gateway/lib

WORKDIR /app/qr-gateway
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
