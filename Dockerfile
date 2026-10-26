FROM oven/bun:1.2-alpine

WORKDIR /app

COPY package.json tsconfig.json ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY test ./test

CMD ["bun", "run", "src/main.ts"]
