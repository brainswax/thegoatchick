# Import latest node.js LTS version
FROM node:16-alpine

# Working directory
WORKDIR /usr/src/app

# Copy the npm package dependencies
COPY package*.json ./

# Install python3/pip3
ENV PYTHONUNBUFFERED=1
RUN apk add --update --no-cache python3 && ln -sf python3 /usr/bin/python
RUN python3 -m ensurepip
RUN pip3 install --no-cache --upgrade pip setuptools

# Install make
RUN apk add --update --no-cache make
RUN apk add --update --no-cache gcc
RUN apk add --update --no-cache musl-dev
RUN apk add --update --no-cache g++

# Install all the packages
RUN npm install
# If you are building your code for production
# RUN npm ci --only=production

# Include the application source code
COPY . .

# Run the app
CMD ["npm", "start"]
