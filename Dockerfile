# Use Node.js 22 as base image (matches tsconfig.json)
FROM node:22-alpine

# Set working directory
WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build the project
RUN pnpm build

# Expose port (default for httpStream transport)
EXPOSE 8080

# Default command to run the built server
CMD ["node", "dist/FastMCP.js"]