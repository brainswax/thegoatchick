# Node 24 is the current Maintenance LTS. The app needs Node >= 22.13 for node:sqlite.
FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Point the .env file to /appdata/
RUN ln -s /appdata/.env /app/.env

# Make the checkhash script executable
RUN chmod 755 util/checkhash

CMD ["npm", "start"]
