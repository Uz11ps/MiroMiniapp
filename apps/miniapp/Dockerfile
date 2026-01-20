FROM node:20-alpine AS build
WORKDIR /app/apps/miniapp
COPY apps/miniapp/package.json ./package.json
RUN npm i --legacy-peer-deps
COPY tsconfig.base.json /app/tsconfig.base.json
COPY apps/miniapp .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/apps/miniapp/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]


