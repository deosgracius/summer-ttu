# --- Stage 1: build the React/Vite app into static files ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . ./
RUN npm run build           # tsc -b && vite build -> /app/dist

# --- Stage 2: serve the static build with nginx, proxying the API ---
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
