FROM node:20-alpine

WORKDIR /app

COPY brama-core/apps/wiki-agent/package.json /app/package.json
RUN npm install

COPY brama-core/apps/wiki-agent /app

EXPOSE 3000

CMD ["npm", "run", "start"]
