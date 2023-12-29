FROM node:20
EXPOSE 80
WORKDIR /app
CMD ["yarn", "start"]
ENV NODE_ENV=production
ENV PYTHON_API=http://127.0.0.1:8000
ENV PORT=80

COPY package.json yarn.lock .yarnrc.yml .nvmrc tsconfig.json .
COPY .yarn/ .yarn
RUN yarn install

COPY src/ src
