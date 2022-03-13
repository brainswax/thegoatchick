# Import latest node.js LTS version
FROM node:16

# Working directory
WORKDIR /usr/src/app

# Copy the npm dependencies
COPY package*.json ./

# Install all the packages
RUN npm install
# If you are building your code for production
# RUN npm ci --only=production

# Include the application source code
COPY . .

# Run the app
CMD ["npm", "start"]
