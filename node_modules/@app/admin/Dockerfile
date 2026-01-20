FROM node:20-alpine AS build
WORKDIR /app/apps/admin
COPY apps/admin/package.json ./package.json
RUN npm i --legacy-peer-deps
# tsconfig base нужен для extends "../../tsconfig.base.json"
COPY tsconfig.base.json /app/tsconfig.base.json
COPY apps/admin .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]


