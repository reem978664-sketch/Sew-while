# Use official Node.js image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files first (to use cache)
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the files
COPY . .

# Expose the port (same as in your env and fly.toml)
EXPOSE 8080

# Start the app
CMD ["npm", "start"]
