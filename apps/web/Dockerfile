FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @munni/web
COPY apps/web apps/web
# build number comes from git normally; docker builds pass it explicitly
ARG BUILD_NUMBER=0
ARG VITE_API_URL=""
ARG VITE_LOGTO_ENDPOINT=""
ARG VITE_LOGTO_APP_ID=""
ARG VITE_LOGTO_RESOURCE=""
ARG VITE_GLITCHTIP_DSN=""
# staging | production
ARG VITE_CHANNEL=""
ENV VITE_API_URL=$VITE_API_URL \
    VITE_LOGTO_ENDPOINT=$VITE_LOGTO_ENDPOINT \
    VITE_LOGTO_APP_ID=$VITE_LOGTO_APP_ID \
    VITE_LOGTO_RESOURCE=$VITE_LOGTO_RESOURCE \
    VITE_GLITCHTIP_DSN=$VITE_GLITCHTIP_DSN \
    VITE_CHANNEL=$VITE_CHANNEL
RUN sed -i "s/execSync('git rev-list --count HEAD').toString().trim()/'${BUILD_NUMBER}'/" apps/web/vite.config.ts || true
RUN npm run build --workspace @munni/web

FROM nginx:alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
# runtime config from MUNNI_* env at start: one image serves every stack (empty env = baked config)
COPY --chmod=755 deploy/nginx/40-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
