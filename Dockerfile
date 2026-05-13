
FROM node:20-slim



WORKDIR /app



COPY package.json package-lock.json ./



RUN npm ci --omit=dev



COPY lookup.js ./



EXPOSE 3456



CMD ["node", "lookup.js"]

