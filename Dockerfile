# Import the base image
FROM node:16-alpine

# Working directory
WORKDIR /app

# Copy the source code
COPY . .

# Install linux dependencies
ENV PYTHONUNBUFFERED=1
RUN apk add --update --no-cache make gcc musl g++
RUN apk add python3 --update --no-cache && ln -sf python3 /usr/bin/python
#   && python3 -m ensurepip && pip3 install --no-cache --upgrade pip setuptools

# Install npm dependencies
RUN npm install -g npm@8.5.4 nodemon
RUN npm install
# If you are building your code for production
# RUN npm ci --only=production

# Point the .env file to /appdata/
RUN ln -s /appdata/.env /app/.env

# Run the app
CMD ["npm", "start"]
