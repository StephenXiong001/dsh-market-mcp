# Container image for dsh-market-mcp.
#
# The server speaks MCP over stdio, so the image is meant to be attached to a
# client's stdin/stdout rather than published on a port.

FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY bin ./bin
COPY lib ./lib
COPY README.md ./
COPY LICENSE ./

RUN chmod +x bin/server.js

ENV NODE_ENV=production

# stdio transport: no port is exposed, and the process must stay in the foreground.
ENTRYPOINT ["node", "bin/server.js"]
