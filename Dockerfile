# Multi-stage build for efficient container size
FROM node:26-alpine AS builder

# Build arguments
ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"
ARG NODE_AUTH_TOKEN

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies with GitHub Packages auth (token never persists in a layer's
# final filesystem thanks to the same-layer rm; .dockerignore keeps the committed
# env-referencing .npmrc out of the build context entirely)
RUN echo "@wyre-technology:registry=https://npm.pkg.github.com" > .npmrc && \
    echo "//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}" >> .npmrc && \
    npm ci --ignore-scripts && \
    rm -f .npmrc

# Copy source code
COPY . .

# Build the application, then prune dev dependencies in the builder stage so the
# production stage copies an already-slim node_modules (avoids re-installing
# git deps which need build tools)
RUN npm run build && \
    npm prune --omit=dev && \
    npm cache clean --force

# Production stage
FROM node:26-alpine AS production

# Create a non-root user for security
RUN addgroup -g 1001 -S scalepad && \
    adduser -S scalepad -u 1001 -G scalepad

# Set working directory
WORKDIR /app

# Copy package files and built application from builder stage
COPY package*.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

# Create logs directory
RUN mkdir -p /app/logs && chown -R scalepad:scalepad /app

# Switch to non-root user
USER scalepad

# Expose port for HTTP transport
EXPOSE 8080

# Health check against the HTTP endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Set environment variables
ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_PORT=8080
ENV MCP_HTTP_HOST=0.0.0.0
# Hosted deployment default: credentials arrive per-request via X-ScalePad-* /
# X-Quoter-* headers. Set AUTH_MODE=env for single-tenant/local use with
# SCALEPAD_API_KEY et al.
ENV AUTH_MODE=gateway

# Define volume for logs
VOLUME ["/app/logs"]

# Start the application
CMD ["node", "dist/index.js"]

# Build arguments for runtime
ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"

# OCI Labels for metadata
LABEL maintainer="engineering@wyre.ai"
LABEL version="${VERSION}"
LABEL description="ScalePad MCP Server - Model Context Protocol server for the ScalePad platform (Core, Lifecycle Manager, ControlMap, Backup Radar, Quoter)"
LABEL org.opencontainers.image.title="scalepad-mcp"
LABEL org.opencontainers.image.description="Model Context Protocol server for the ScalePad platform (Core, Lifecycle Manager, ControlMap, Backup Radar, Quoter)"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.revision="${COMMIT_SHA}"
LABEL org.opencontainers.image.source="https://github.com/wyre-technology/scalepad-mcp"
LABEL org.opencontainers.image.documentation="https://github.com/wyre-technology/scalepad-mcp/blob/main/README.md"
LABEL org.opencontainers.image.url="https://github.com/wyre-technology/scalepad-mcp/pkgs/container/scalepad-mcp"
LABEL org.opencontainers.image.vendor="Wyre Technology"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL io.modelcontextprotocol.server.name="io.github.wyre-technology/scalepad-mcp"
