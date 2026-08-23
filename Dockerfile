# Stage 1: Build React Frontend
FROM node:20-alpine as client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# Stage 2: Setup Node Logic Backend
FROM node:20-alpine
WORKDIR /app
COPY server/package*.json ./
RUN npm install --production

# Copy backend code
COPY server/ ./

# Copy built frontend assets to public directory
# Ensure public dir exists
RUN mkdir -p public
COPY --from=client-build /app/client/dist ./public

# Expose port
EXPOSE 8080

# Persistent dashboard data (cards, uploaded icons, cached images)
ENV PORT=8080
ENV NODE_ENV=production
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data/uploads
VOLUME ["/app/data"]

# Start command
CMD ["npm", "start"]
