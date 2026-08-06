FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

FROM nginx:1.25-alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Shared proxy settings included by every location block in nginx.conf.
# Goes in /etc/nginx/ (not conf.d/) — anything in conf.d is auto-included at the
# http level, and these are server/location-level directives, so nginx would
# refuse to start with "directive is not allowed here".
COPY proxy-common.conf /etc/nginx/proxy-common.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
