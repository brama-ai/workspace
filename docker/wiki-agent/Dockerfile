FROM node:20-alpine

WORKDIR /app

COPY agents/wiki-agent/package.json /app/package.json
RUN npm install

COPY agents/wiki-agent /app

EXPOSE 3000

CMD ["npm", "run", "start"]
