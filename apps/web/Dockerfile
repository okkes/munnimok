# Build the PWA and serve it with nginx (service-worker-safe caching)
FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @munni/web
COPY apps/web apps/web
# build number comes from git normally; docker builds pass it explicitly
ARG BUILD_NUMBER=0
RUN sed -i "s/execSync('git rev-list --count HEAD').toString().trim()/'${BUILD_NUMBER}'/" apps/web/vite.config.ts || true
RUN npm run build --workspace @munni/web

FROM nginx:alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
