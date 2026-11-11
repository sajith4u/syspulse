# Builds the Linux packages (AppImage + .deb) in a clean container.
#
#   docker build --output dist .
#
# The packages are written to ./dist on the host. See README "Building with Docker".

FROM node:22-bookworm AS build

WORKDIR /app

# Install dependencies first so this layer is cached until package files change.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run dist

# Export stage: only the finished packages, so `--output` copies just these.
FROM scratch AS export
COPY --from=build /app/dist/*.AppImage /app/dist/*.deb /
