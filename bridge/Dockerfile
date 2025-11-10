# Bridge container: WebTransport (HTTP/3/QUIC) → EMQX QUIC
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Tools + NodeSource
RUN apt-get update && \
    apt-get install -y curl ca-certificates gnupg lsb-release && \
    rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get update && \
    apt-get install -y nodejs build-essential python3 make g++ cmake pkg-config libssl-dev libicu-dev git && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Install JS deps first (better caching)
COPY package*.json ./
RUN npm install \
 && npm install @fails-components/webtransport-transport-http3-quiche@1.4.4 \
 && node -e "require('@fails-components/webtransport-transport-http3-quiche'); console.log('quiche transport OK')"

# App source
COPY . .

ENV NODE_ENV=production

# Bridge env (override at run-time as needed)
ENV BRIDGE_HOST=0.0.0.0
ENV BRIDGE_PORT=1027
ENV BRIDGE_CERT_FILE=/certs/fullchain.pem
ENV BRIDGE_KEY_FILE=/certs/privkey.pem

ENV EMQX_HOST=emqx
ENV EMQX_QUIC_PORT=14567
ENV EMQX_SNI=nam5gxr.duckdns.org

EXPOSE 1027/udp

CMD ["node", "src/server.mjs"]
