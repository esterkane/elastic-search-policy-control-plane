FROM node:24

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ENV HOST=0.0.0.0
ENV PORT=3000
ENV ELASTICSEARCH_URL=http://elasticsearch:9200

EXPOSE 3000

CMD ["npm", "run", "dev"]
